'use client';

import { useCallback, useEffect, useState } from 'react';
import { Icon } from './Icon';
import { postJson } from './stepup';

/*
 * Expenses (PRD Module 5): what Finance owes, who holds advances, and the
 * policy every new claim is routed by. Approval and payment are separate:
 * a claim shows "paid" only after Finance records a payment reference.
 */

type Tab = 'claims' | 'advances' | 'settings';
type Settlement = {
  id: string; instance_id: string; claimant: string; claimant_name: string; amount: string; currency: string;
  status: 'awaiting_payment' | 'paid' | 'failed' | 'void'; reference: string | null; note: string | null;
  paid_at: string | null; created_at: string; advance_reference: string | null;
};
type Advance = {
  id: string; instance_id: string; reference: string; holder: string; holder_name: string; amount: string; currency: string;
  status: 'approved' | 'disbursed' | 'awaiting_return' | 'retired' | 'void'; outstanding: string; spent: string; returned: string;
  disbursed_at: string | null; due_at: string | null; overdue: boolean;
};
type Settings = { categories: string[]; autoApproveLimit: number; managerLimit: number; lineLimit: number; receiptThreshold: number; advanceRetirementDays: number };
type Summary = { currency: string; awaitingPayment: number; awaitingAmount: number; failed: number; paidLast30Days: number; advancesOpen: number; advancesOverdue: number; heldOnAdvances: number };

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.reason ?? body.error ?? `HTTP ${res.status}`);
  return body as T;
}
function useFeed<T>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try { setData(await get<T>(path)); setError(null); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  }, [path]);
  useEffect(() => { void reload(); }, [reload]);
  return { data, error, reload };
}

const money = (v: string | number, c: string) => `${c} ${Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = (v: string | null) => (v ? new Date(v).toLocaleDateString() : '');

const SETTLEMENT_WORDS: Record<Settlement['status'], string> = {
  awaiting_payment: 'Approved, not paid yet',
  paid: 'Paid',
  failed: 'Payment failed — still owed',
  void: 'Void',
};
const ADVANCE_WORDS: Record<Advance['status'], string> = {
  approved: 'Approved, not paid out',
  disbursed: 'Paid out, to be retired',
  awaiting_return: 'Balance to be returned',
  retired: 'Retired',
  void: 'Void',
};

export function ExpensesView({ canAdminister, onOpenRecord }: { canAdminister: boolean; onOpenRecord: (instanceId: string) => void }) {
  const [tab, setTab] = useState<Tab>('claims');
  const summary = useFeed<Summary>('/api/expenses/summary');
  const settlements = useFeed<Settlement[]>('/api/expenses/settlements');
  const advances = useFeed<Advance[]>('/api/expenses/advances');
  const settings = useFeed<Settings>('/api/expenses/settings');
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [acting, setActing] = useState<{ id: string; kind: 'pay' | 'fail' | 'void' | 'disburse' | 'return' } | null>(null);
  const [reference, setReference] = useState('');
  const [reason, setReason] = useState('');
  const [amount, setAmount] = useState('');
  const [draft, setDraft] = useState<Settings | null>(null);
  const [categoriesText, setCategoriesText] = useState('');
  const [showClosed, setShowClosed] = useState(false);

  useEffect(() => {
    if (settings.data) { setDraft(settings.data); setCategoriesText(settings.data.categories.join(', ')); }
  }, [settings.data]);

  const reloadAll = async () => { await Promise.all([summary.reload(), settlements.reload(), advances.reload()]); };
  const act = async (id: string, work: () => Promise<string>) => {
    setBusy(id); setNote(null);
    try { setNote(await work()); setActing(null); setReference(''); setReason(''); setAmount(''); await reloadAll(); }
    catch (err) { setNote(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(null); }
  };

  const s = summary.data;
  const cur = s?.currency ?? '';
  const openSettlements = (settlements.data ?? []).filter((x) => showClosed || x.status === 'awaiting_payment' || x.status === 'failed');
  const openAdvances = (advances.data ?? []).filter((x) => showClosed || !['retired', 'void'].includes(x.status));
  const tabs: { id: Tab; name: string; count: number; icon: 'table' | 'export' | 'trail' }[] = [
    { id: 'claims', name: 'Claims to pay', count: (s?.awaitingPayment ?? 0) + (s?.failed ?? 0), icon: 'table' },
    { id: 'advances', name: 'Advances', count: s?.advancesOpen ?? 0, icon: 'export' },
    { id: 'settings', name: 'Policy', count: settings.data?.categories.length ?? 0, icon: 'trail' },
  ];
  const error = { claims: settlements.error, advances: advances.error, settings: settings.error }[tab] ?? summary.error;

  const actionForm = (id: string) => {
    if (!acting || acting.id !== id) return null;
    const k = acting.kind;
    const needsRef = k === 'pay' || k === 'disburse' || k === 'return';
    const label = { pay: 'Record payment', fail: 'Mark payment failed', void: 'Void this claim', disburse: 'Record pay-out', return: 'Record money returned' }[k];
    return <form className="ig__form" style={{ margin: '0 0 12px' }} onSubmit={(e) => {
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

  return <div className="ig__workspace">
    <header className="ig__hero">
      <span className="ig__eyebrow">EXPENSES</span>
      <h2>What Finance owes, and who holds advances</h2>
      <p>Approved is not paid. A claim shows as paid only when Finance records the payment reference here.</p>
    </header>

    {s && <section className="pp2__overview" aria-label="Expenses at a glance" style={{ marginBottom: 18 }}>
      <div><span>Approved, not paid</span><strong>{s.awaitingPayment}</strong><small>{money(s.awaitingAmount, cur)} owed</small></div>
      <div><span>Payments failed</span><strong>{s.failed}</strong><small>Still owed to staff</small></div>
      <div><span>Advances open</span><strong>{s.advancesOpen}</strong><small>{money(s.heldOnAdvances, cur)} held · {s.advancesOverdue} overdue</small></div>
    </section>}

    <div className="ig__surface">
      <div className="ig__tabs" role="tablist" aria-label="Expenses areas">
        {tabs.map((item, index) => <button key={item.id} id={`ex-tab-${item.id}`} type="button" role="tab" aria-controls={`ex-panel-${item.id}`} aria-selected={tab === item.id} tabIndex={tab === item.id ? 0 : -1} className="ig__tab" onClick={() => { setTab(item.id); setActing(null); setNote(null); }} onKeyDown={(event) => { const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index - 1 + tabs.length) % tabs.length : -1; if (next < 0) return; event.preventDefault(); const id = tabs[next]!.id; setTab(id); setActing(null); document.getElementById(`ex-tab-${id}`)?.focus(); }}>
          <Icon name={item.icon} /><span>{item.name}</span><span className="ig__tabCount">{item.count}</span>
        </button>)}
      </div>

      <section id={`ex-panel-${tab}`} role="tabpanel" aria-labelledby={`ex-tab-${tab}`} className="ig__panel">
        <div className="ig__panelHead">
          <div>
            <h3>{tab === 'claims' ? 'Approved claims' : tab === 'advances' ? 'Cash advances' : 'Expense policy'}</h3>
            <p>{tab === 'claims' ? 'Record each payment with its reference. A failed payment stays owed; a paid claim cannot be changed.'
              : tab === 'advances' ? 'Record when an advance is paid out. The holder retires it with an expense claim that quotes its reference, or returns the balance.'
              : 'Every new claim copies these numbers when it is submitted, so a change here never re-routes a claim already in progress.'}</p>
          </div>
          {tab !== 'settings' && <label className="pp2__inlineLabel"><input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} /> Show paid and closed</label>}
        </div>
        {note && <p className="ig__notice" role="status">{note}</p>}
        {error && <p className="ig__error" role="alert">{error}</p>}

        {tab === 'claims' && <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {openSettlements.map((x) => <li key={x.id} className="ig__row" style={{ flexWrap: 'wrap' }}>
            <div className="ig__rowMain">
              <strong>{x.claimant_name}</strong>
              <span className={`ig__status ${x.status === 'paid' ? '' : 'ig__status--off'}`}>{SETTLEMENT_WORDS[x.status]}</span>
              <p>{money(x.amount, x.currency)} · approved {day(x.created_at)}{x.advance_reference ? ` · after advance ${x.advance_reference}` : ''}{x.reference ? ` · ref ${x.reference}` : ''}{x.paid_at ? ` · paid ${day(x.paid_at)}` : ''}{x.note ? ` · ${x.note}` : ''}</p>
              {actionForm(x.id)}
            </div>
            <div className="pp2__roleEdit">
              <button type="button" className="cs__btn" onClick={() => onOpenRecord(x.instance_id)}>Open claim</button>
              {(x.status === 'awaiting_payment' || x.status === 'failed') && <>
                <button type="button" className="cs__btn cs__btn--primary" onClick={() => setActing({ id: x.id, kind: 'pay' })}>Record payment</button>
                {x.status === 'awaiting_payment' && <button type="button" className="cs__btn" onClick={() => setActing({ id: x.id, kind: 'fail' })}>Payment failed</button>}
                <button type="button" className="cs__btn" onClick={() => setActing({ id: x.id, kind: 'void' })}>Void</button>
              </>}
            </div>
          </li>)}
          {settlements.data && !openSettlements.length && <li className="ig__row"><div className="ig__rowMain"><p>Nothing waiting to be paid.</p></div></li>}
        </ul>}

        {tab === 'advances' && <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
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

        {tab === 'settings' && draft && <form className="ig__form" onSubmit={(e) => {
          e.preventDefault();
          void act('settings', async () => {
            await postJson('/api/expenses/settings', { ...draft, categories: categoriesText.split(',').map((c) => c.trim()).filter(Boolean) });
            await settings.reload();
            return 'Policy saved. New claims use it from now on.';
          });
        }}>
          <div className="ig__formTitle"><strong>Limits</strong><p>Amounts are in the workspace currency{cur ? ` (${cur})` : ''}.</p></div>
          <div><label className="cs__label" htmlFor="ex-auto">Approve automatically up to</label><input id="ex-auto" className="cs__input" inputMode="decimal" disabled={!canAdminister} value={draft.autoApproveLimit} onChange={(e) => setDraft({ ...draft, autoApproveLimit: Number(e.target.value) })} /></div>
          <div><label className="cs__label" htmlFor="ex-mgr">Manager alone approves up to</label><input id="ex-mgr" className="cs__input" inputMode="decimal" disabled={!canAdminister} value={draft.managerLimit} onChange={(e) => setDraft({ ...draft, managerLimit: Number(e.target.value) })} /></div>
          <div><label className="cs__label" htmlFor="ex-line">Any single item over this goes to Finance</label><input id="ex-line" className="cs__input" inputMode="decimal" disabled={!canAdminister} value={draft.lineLimit} onChange={(e) => setDraft({ ...draft, lineLimit: Number(e.target.value) })} /></div>
          <div><label className="cs__label" htmlFor="ex-receipt">Receipt needed for claims over</label><input id="ex-receipt" className="cs__input" inputMode="decimal" disabled={!canAdminister} value={draft.receiptThreshold} onChange={(e) => setDraft({ ...draft, receiptThreshold: Number(e.target.value) })} /></div>
          <div><label className="cs__label" htmlFor="ex-days">Days to retire an advance</label><input id="ex-days" className="cs__input" inputMode="numeric" disabled={!canAdminister} value={draft.advanceRetirementDays} onChange={(e) => setDraft({ ...draft, advanceRetirementDays: Number(e.target.value) })} /></div>
          <div style={{ gridColumn: '1 / -1' }}><label className="cs__label" htmlFor="ex-cats">Categories Finance accepts (comma separated)</label><input id="ex-cats" className="cs__input" disabled={!canAdminister} value={categoriesText} onChange={(e) => setCategoriesText(e.target.value)} /></div>
          {canAdminister ? <button type="submit" className="cs__btn cs__btn--primary" disabled={busy === 'settings'}>{busy === 'settings' ? 'Saving…' : 'Save policy'}</button>
            : <p className="ig__rowMain">Only owners and admins can change the policy.</p>}
        </form>}
      </section>
    </div>
  </div>;
}
