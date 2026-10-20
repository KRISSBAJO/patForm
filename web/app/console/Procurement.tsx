'use client';

import './meetings.css';
import { EmptyState, ShellSync, type ModuleShell } from './module-shell';
import { useCallback, useEffect, useState } from 'react';
import { postJson } from './stepup';

/*
 * Procurement (PRD Module 6): approved requests to source and order, orders
 * to receive, invoices to match and pay, suppliers, agreements, budgets and
 * the rules. Requesters never see this page's quotes: they follow progress
 * on their own request record.
 */

type Tab = 'requests' | 'orders' | 'invoices' | 'suppliers' | 'agreements' | 'budgets' | 'rules';
type Req = { id: string; instance_id: string; reference: string; requester_name: string; title: string | null; amount: string; currency: string; cost_centre: string | null; needed_by: string | null; status: string; quotes: number; quotes_open_at: string | null; quotes_opened: boolean; selected_quote_id: string | null; selection_reason: string | null; order_number: number | null };
type Quote = { id: string; vendor_id: string; vendor_name: string; amount: string | null; lead_days: number | null; notes: string | null; received_at: string };
type Vendor = { id: string; name: string; tax_id: string | null; registration_no: string | null; contact_name: string | null; contact_email: string | null; contact_phone: string | null; categories: string[]; status: string; status_reason: string | null; bank_name: string | null; bank_last4: string | null; bank_verified: boolean; orders: number; on_time: number; delivered_with_date: number; rejected_qty: string; delivered_qty: string; invoices_held: number; due_diligence: string | null; documents_ref: string | null };
type Order = { id: string; number: number; status: string; revision: number; currency: string; total: string; approved_total: string; expected_by: string | null; vendor_name: string; vendor_status: string; requisition_reference: string | null; agreement_title: string | null; exception_reason: string | null; created_by_name: string | null };
type Line = { id: string; lineNo: number; description: string; kind: string; quantity: number; unitPrice: number; accepted: number; rejected: number; returned: number; netAccepted: number; toCome: number; invoiced: number; toInvoice: number };
type OrderDetail = Order & { lines: Line[]; revisions: { revision: number; total: string; reason: string | null; occurred_at: string; actor_name: string | null }[] };
type Invoice = { id: string; invoice_no: string; invoice_date: string; currency: string; total: string; status: string; mismatches: string[]; review_reason: string | null; payment_ref: string | null; paid_at: string | null; exported_at: string | null; vendor_name: string; order_number: number; entered_by_name: string | null; reviewed_by_name: string | null; bank_verified: boolean };
type Agreement = { id: string; vendor_name: string; title: string; limit_amount: string; valid_from: string; valid_to: string; used: string; remaining: number };
type Budget = { id: string; cost_centre: string; period_start: string; period_end: string; amount: string; mode: string; reserved: string; consumed: string; available: number };
type Rules = { managerLimit: number; priceTolerancePct: number; amountTolerance: number; orderIncreasePct: number; quotesRequired: number; quotesRequiredOver: number; requireVendorBankCheck: boolean; currency: string };
type Summary = { currency: string; toOrder: number; ordersPending: number; ordersOpen: number; invoicesHeld: number; invoicesToPay: number; toPayAmount: number; vendorsToReview: number; banksUnchecked: number };

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
    try { setData(await get<T>(path)); setError(null); } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  }, [path]);
  useEffect(() => { void reload(); }, [reload]);
  return { data, error, reload };
}
const money = (v: string | number | null | undefined, c: string) => `${c} ${Number(v ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const short = (v: string | number | null | undefined) => Number(v ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
const day = (v: string | null | undefined) => (v ? new Date(v).toLocaleDateString([], { dateStyle: 'medium' }) : '');
const words = (s: string) => s.replace(/_/g, ' ');
const initials = (n: string) => n.split(' ').map((p) => p[0]).join('').slice(0, 2).toUpperCase();

const ORDER_WORDS: Record<string, string> = { pending_approval: 'Waiting for approval', issued: 'Ordered', partially_received: 'Partly received', received: 'All received', closed: 'Closed', cancelled: 'Cancelled' };
const INVOICE_WORDS: Record<string, string> = { held: 'Held — mismatch', approved: 'Approved to pay', paid: 'Paid', rejected: 'Rejected', void: 'Void' };
const pillOf = (s: string) => ({ approved: 'passed', sourcing: 'open', pending_approval: 'open', issued: 'called', partially_received: 'open', received: 'passed', closed: 'passed', cancelled: 'cancelled', held: 'failed', paid: 'passed', rejected: 'failed', void: 'cancelled', draft: 'draft', under_review: 'open', restricted: 'open', suspended: 'failed', archived: 'cancelled', enforced: 'called', advisory: 'draft' }[s] ?? 'draft');
const Pill = ({ s, text }: { s: string; text?: string }) => <span className={`mx__pill mx__pill--${pillOf(s)}`}><i />{text ?? words(s)}</span>;
const Field = ({ label, children, wide }: { label: string; children: React.ReactNode; wide?: boolean }) => <div className={`mx__field ${wide ? 'mx__field--wide' : ''}`}><label>{label}</label>{children}</div>;
const Avatar = ({ name, text }: { name: string; text?: string }) => <span className="mx__avatar mx__avatar--lg" style={{ marginLeft: 0, fontSize: text ? 11 : undefined }}>{text ?? initials(name)}</span>;
const Bar = ({ value, max, warn }: { value: number; max: number; warn?: boolean }) => <div className="mx__voteBar" style={{ height: 6 }}><span className="is-for" style={{ width: `${max > 0 ? Math.min(100, (value / max) * 100) : 0}%`, background: warn ? '#c0392b' : 'var(--mod, #1f5fa8)' }} /></div>;

export function ProcurementView({ canAdminister, canOperate, onOpenRecord, shell }: { canAdminister: boolean; canOperate: boolean; onOpenRecord: (instanceId: string) => void; shell?: ModuleShell }) {
  const [tab, setTab] = useState<Tab>('requests');
  const pickTab = (id: Tab) => { setTab(id); shell?.onSection?.(id); };
  const on = canOperate;
  const summary = useFeed<Summary>(on ? '/api/procurement/summary' : null);
  const reqs = useFeed<Req[]>(on ? '/api/procurement/requests' : null);
  const orders = useFeed<Order[]>(on ? '/api/procurement/orders' : null);
  const invoices = useFeed<Invoice[]>(on ? '/api/procurement/invoices' : null);
  const vendors = useFeed<Vendor[]>(on ? '/api/procurement/vendors' : null);
  const agreements = useFeed<Agreement[]>(on ? '/api/procurement/agreements' : null);
  const budgets = useFeed<Budget[]>(on ? '/api/expenses/budgets' : null);
  const rules = useFeed<Rules>(on ? '/api/procurement/settings' : null);
  const [note, setNote] = useState<{ text: string; err?: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [panel, setPanel] = useState<'quote' | 'seal' | 'order' | 'receive' | 'invoice' | 'revise' | null>(null);
  const [quotes, setQuotes] = useState<{ sealed: boolean; opensAt: string | null; quotes: Quote[] } | null>(null);
  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [lines, setLines] = useState<{ description: string; quantity: string; unitPrice: string }[]>([{ description: '', quantity: '1', unitPrice: '' }]);
  const [qty, setQty] = useState<Record<string, { a: string; r: string; why: string; price?: string }>>({});
  const [vendorForm, setVendorForm] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState<null | 'vendor' | 'agreement'>(null);
  const [ruleDraft, setRuleDraft] = useState<Rules | null>(null);
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [orderFilter, setOrderFilter] = useState<'open' | 'all'>('open');
  const [invoiceFilter, setInvoiceFilter] = useState<'open' | 'all'>('open');
  // A reason or reference asked for inline, never with a browser pop-up.
  const [asking, setAsking] = useState<{ id: string; label: string; run: (answer: string) => Promise<string> } | null>(null);
  const [answer, setAnswer] = useState('');
  useEffect(() => { if (rules.data) setRuleDraft(rules.data); }, [rules.data]);

  useEffect(() => {
    if (shell?.section && shell.section !== tab) { setTab(shell.section as Tab); setOpen(null); setPanel(null); setNote(null); setForm({}); setAdding(null); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shell?.section]);
  const cur = summary.data?.currency ?? rules.data?.currency ?? '';
  const f = (k: string) => form[k] ?? '';
  const setF = (k: string, v: string) => setForm((x) => ({ ...x, [k]: v }));
  const reloadAll = async () => { await Promise.all([summary.reload(), reqs.reload(), orders.reload(), invoices.reload(), vendors.reload(), agreements.reload(), budgets.reload()]); };
  const act = async (id: string, work: () => Promise<string>) => {
    setBusy(id); setNote(null);
    try { setNote({ text: await work() }); await reloadAll(); }
    catch (err) { setNote({ text: err instanceof Error ? err.message : String(err), err: true }); }
    finally { setBusy(null); }
  };
  const ask = (id: string, label: string, run: (a: string) => Promise<string>) => { setAsking({ id, label, run }); setAnswer(''); };
  const toggleReq = async (r: Req) => {
    if (open === r.id) { setOpen(null); setPanel(null); return; }
    setOpen(r.id); setPanel(null); setForm({}); setQuotes(await get(`/api/procurement/requests/${r.id}/quotes`));
    setLines([{ description: r.title ?? '', quantity: '1', unitPrice: '' }]);
  };
  const toggleOrder = async (o: Order) => {
    if (open === o.id) { setOpen(null); setPanel(null); return; }
    setOpen(o.id); setPanel(null); setForm({}); setQty({});
    const d = await get<OrderDetail>(`/api/procurement/orders/${o.id}`);
    setDetail(d);
    setLines(d.lines.map((l) => ({ description: l.description, quantity: String(l.quantity), unitPrice: String(l.unitPrice) })));
  };
  const lineEditor = (prefix: string) => <div className="mx__field--wide">
    <table className="ex__table"><thead><tr><th scope="col">Item</th><th scope="col">Quantity</th><th scope="col">Unit price ({cur})</th><th scope="col"><span className="ex__sr">Remove</span></th></tr></thead>
      <tbody>{lines.map((l, i) => <tr key={i}>
        <td><label className="ex__sr" htmlFor={`${prefix}-d-${i}`}>Item {i + 1}</label><input id={`${prefix}-d-${i}`} className="mx__input" value={l.description} onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, description: e.target.value } : x))} /></td>
        <td><label className="ex__sr" htmlFor={`${prefix}-q-${i}`}>Quantity {i + 1}</label><input id={`${prefix}-q-${i}`} className="mx__input" inputMode="decimal" value={l.quantity} onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, quantity: e.target.value } : x))} /></td>
        <td><label className="ex__sr" htmlFor={`${prefix}-p-${i}`}>Unit price {i + 1}</label><input id={`${prefix}-p-${i}`} className="mx__input" inputMode="decimal" value={l.unitPrice} onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, unitPrice: e.target.value } : x))} /></td>
        <td>{lines.length > 1 && <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => setLines(lines.filter((_, j) => j !== i))}>Remove</button>}</td>
      </tr>)}</tbody></table>
    <div className="mx__bar" style={{ marginTop: 8 }}><button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => setLines([...lines, { description: '', quantity: '1', unitPrice: '' }])}>+ Add a line</button><strong className="pr__total">Order total {money(lines.reduce((s, l) => s + Number(l.quantity || 0) * Number(l.unitPrice || 0), 0), cur)}</strong></div>
  </div>;
  const lineBody = () => lines.map((l) => ({ description: l.description, quantity: Number(l.quantity), unitPrice: Number(l.unitPrice) }));
  const approvedVendors = (vendors.data ?? []).filter((v) => !['draft', 'under_review', 'archived'].includes(v.status));
  const seg = (k: string, cur: string, set: (v: never) => void, label: string) => <button type="button" className={`mx__seg ${cur === k ? 'is-on' : ''}`} onClick={() => set(k as never)}>{label}</button>;
  const panelBtn = (id: 'quote' | 'seal' | 'order' | 'receive' | 'invoice' | 'revise', label: string, primary?: boolean) => <button type="button" className={`mx__btn mx__btn--sm ${panel === id ? '' : primary ? '' : 'mx__btn--ghost'} ${panel === id ? 'is-on' : ''}`} aria-expanded={panel === id} onClick={() => { setPanel(panel === id ? null : id); setForm({}); }}>{label}</button>;

  if (!on) return <div className="mx"><section className="mx__band"><div className="mx__bandGrid"><div><div className="mx__eyebrow">Procurement</div><h2 className="mx__bandTitle">Buying for the organisation</h2><p className="mx__bandSub">To ask for something to be bought, use the Purchase request form. Procurement staff manage suppliers, orders and invoices here.</p></div></div></section></div>;

  const s = summary.data;
  const tabs: { id: Tab; name: string; count: number | null }[] = [
    { id: 'requests', name: 'To order', count: s?.toOrder || null },
    { id: 'orders', name: 'Orders', count: ((s?.ordersPending ?? 0) + (s?.ordersOpen ?? 0)) || null },
    { id: 'invoices', name: 'Invoices', count: ((s?.invoicesHeld ?? 0) + (s?.invoicesToPay ?? 0)) || null },
    { id: 'suppliers', name: 'Suppliers', count: vendors.data?.length || null },
    { id: 'agreements', name: 'Agreements', count: agreements.data?.length || null },
    { id: 'budgets', name: 'Budgets', count: budgets.data?.length || null },
    { id: 'rules', name: 'Rules', count: null },
  ];
  const error = ({ requests: reqs.error, orders: orders.error, invoices: invoices.error, suppliers: vendors.error, agreements: agreements.error, budgets: budgets.error, rules: rules.error } as Record<Tab, string | null>)[tab] ?? summary.error;
  const toOrder = (reqs.data ?? []).filter((r) => r.status === 'approved' || r.status === 'sourcing');
  const orderList = (orders.data ?? []).filter((o) => orderFilter === 'all' || !['closed', 'cancelled'].includes(o.status));
  const invoiceList = (invoices.data ?? []).filter((i) => invoiceFilter === 'all' || ['held', 'approved'].includes(i.status));

  return <div className="mx">
    <ShellSync sections={tabs} onSections={shell?.onSections} />
    {!shell && <div className="mx__segs" style={{ marginBottom: 14 }}>{tabs.map((t) => <button key={t.id} type="button" className={`mx__seg ${tab === t.id ? 'is-on' : ''}`} onClick={() => { pickTab(t.id); setOpen(null); setNote(null); setForm({}); }}>{t.name}{t.count ? ` · ${t.count}` : ''}</button>)}</div>}

    <section className="mx__band">
      <div className="mx__bandGrid">
        <div>
          <div className="mx__eyebrow">Procurement</div>
          <h2 className="mx__bandTitle">{s && s.toOrder ? `${s.toOrder} request${s.toOrder === 1 ? '' : 's'} to order` : s && s.invoicesHeld ? `${s.invoicesHeld} invoice${s.invoicesHeld === 1 ? '' : 's'} held` : 'From approved request to paid invoice'}</h2>
          <p className="mx__bandSub">Order from approved suppliers, record what actually arrived, and pay only for what was accepted. Mismatched invoices wait here with the reason.</p>
          <div className="mx__bandActions">
            <button type="button" className="mx__btn mx__btn--light" onClick={() => pickTab('requests')}>Order now</button>
            <button type="button" className="mx__btn mx__btn--outline" onClick={() => pickTab('invoices')}>Invoices</button>
            <button type="button" className="mx__btn mx__btn--outline" onClick={() => { pickTab('suppliers'); setAdding('vendor'); }}>+ Supplier</button>
          </div>
        </div>
        {s && <>
          <div className={`mx__kpi ${s.toOrder ? 'mx__kpi--live' : ''}`}><span>To order</span><strong>{s.toOrder}</strong><small>{s.ordersPending} order{s.ordersPending === 1 ? '' : 's'} waiting for approval · {s.ordersOpen} open</small></div>
          <div className={`mx__kpi ${s.invoicesHeld ? 'mx__kpi--live' : ''}`}><span>Invoices</span><strong>{s.invoicesHeld + s.invoicesToPay}</strong><small>{s.invoicesHeld} held · {s.invoicesToPay} to pay · {money(s.toPayAmount, s.currency)}</small></div>
          <div className="mx__kpi"><span>Suppliers to review</span><strong>{s.vendorsToReview}</strong><small>{s.banksUnchecked} bank detail{s.banksUnchecked === 1 ? '' : 's'} to check</small></div>
        </>}
      </div>
    </section>

    {note && <p className={`mx__notice ${note.err ? 'mx__notice--err' : ''}`} style={{ marginTop: 16 }} role="status">{note.text}</p>}
    {error && <p className="mx__notice mx__notice--err" style={{ marginTop: 16 }} role="alert">{error}</p>}
    {asking && <form className="mx__ask" style={{ marginTop: 16 }} onSubmit={(e) => { e.preventDefault(); const a = answer.trim(); if (!a) return; const job = asking; setAsking(null); setAnswer(''); void act(job.id, () => job.run(a)); }}>
      <label>{asking.label}</label><input required autoFocus value={answer} onChange={(e) => setAnswer(e.target.value)} />
      <div className="mx__voteBtns" style={{ marginTop: 0 }}><button type="submit" className="mx__btn mx__btn--sm">Save</button><button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => { setAsking(null); setAnswer(''); }}>Cancel</button></div>
    </form>}

    <div className="mx__stack" style={{ marginTop: 18 }}>
      {tab === 'requests' && <div className="mx__card"><div className="mx__cardHead"><h3>Approved requests</h3><small>{toOrder.length} to source and order</small></div>
        <div className="ex__records">{toOrder.map((r) => { const isOpen = open === r.id; return <div key={r.id} className={`ex__record ${isOpen ? 'is-open' : ''}`}>
          <div className="ex__recordHead">
            <Avatar name={r.requester_name} />
            <div className="mx__main">
              <strong>{r.title ?? 'Request'} <Pill s={r.status} text={r.status === 'sourcing' ? `${r.quotes} quote${r.quotes === 1 ? '' : 's'}` : 'Approved'} />{r.selected_quote_id && <Pill s="approved" text="Quote chosen" />}</strong>
              <small>{r.reference} · {r.requester_name}{r.cost_centre ? ` · ${r.cost_centre}` : ''}{r.needed_by ? ` · needed by ${day(r.needed_by)}` : ''}</small>
            </div>
            <div className="ex__amount"><strong>{money(r.amount, r.currency)}</strong><small>estimated</small></div>
          </div>
          <div className="ex__recordBtns">
            <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => onOpenRecord(r.instance_id)}>Open request</button>
            <button type="button" className="mx__btn mx__btn--sm" aria-expanded={isOpen} onClick={() => void toggleReq(r)}>{isOpen ? 'Close' : 'Quotes and order'}</button>
          </div>
          {isOpen && quotes && <div className="pr__panel">
            <div className="pr__panelHead"><strong>Quotes</strong>{quotes.sealed && <Pill s="under_review" text={`Sealed until ${new Date(quotes.opensAt!).toLocaleString()}`} />}</div>
            {quotes.sealed && new Date(quotes.opensAt!) < new Date() && <div><button type="button" className="mx__btn mx__btn--sm" onClick={() => void act(r.id, async () => { await postJson(`/api/procurement/requests/${r.id}/open-quotes`, {}); setQuotes(await get(`/api/procurement/requests/${r.id}/quotes`)); return 'Quotes opened.'; })}>Open the quotes</button></div>}
            <ul className="mx__list pr__quotes">{quotes.quotes.map((q) => <li key={q.id} className={r.selected_quote_id === q.id ? 'is-chosen' : ''}>
              <Avatar name={q.vendor_name} />
              <div className="mx__main"><strong>{q.vendor_name}{r.selected_quote_id === q.id && <Pill s="approved" text="Chosen" />}</strong><small>{q.lead_days !== null ? `${q.lead_days} days` : 'no lead time given'}{q.notes ? ` · ${q.notes}` : ''} · received {day(q.received_at)}</small></div>
              <div className="ex__amount"><strong>{q.amount === null ? '••••' : money(q.amount, cur)}</strong><small>{q.amount === null ? 'sealed' : 'quoted'}</small></div>
              {!quotes.sealed && r.selected_quote_id !== q.id && <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => setF('chooseQuote', q.id)}>Choose</button>}
            </li>)}{!quotes.quotes.length && <li><small className="mx__tiny">No quotes recorded yet.</small></li>}</ul>
            {f('chooseQuote') && <form className="mx__ask" onSubmit={(e) => { e.preventDefault(); void act(r.id, async () => { await postJson(`/api/procurement/requests/${r.id}/select`, { quoteId: f('chooseQuote'), reason: f('chooseReason') }); setForm({}); setQuotes(await get(`/api/procurement/requests/${r.id}/quotes`)); return 'Quote chosen.'; }); }}>
              <label>Why this quote</label><input required autoFocus value={f('chooseReason')} onChange={(e) => setF('chooseReason', e.target.value)} />
              <div className="mx__voteBtns" style={{ marginTop: 0 }}><button type="submit" className="mx__btn mx__btn--sm">Choose this quote</button><button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => setF('chooseQuote', '')}>Cancel</button></div>
            </form>}
            <div className="ex__recordBtns">{panelBtn('quote', '+ Record a quote')}{!quotes.opensAt && panelBtn('seal', 'Seal until a deadline')}{panelBtn('order', 'Raise the order', true)}</div>
            {panel === 'quote' && <form className="mx__form pr__form" onSubmit={(e) => { e.preventDefault(); void act(r.id, async () => { await postJson(`/api/procurement/requests/${r.id}/quotes`, { vendorId: f('qVendor'), amount: f('qAmount'), leadDays: f('qDays'), notes: f('qNotes') }); setForm({}); setPanel(null); setQuotes(await get(`/api/procurement/requests/${r.id}/quotes`)); return 'Quote recorded.'; }); }}>
              <Field label="Supplier"><select required value={f('qVendor')} onChange={(e) => setF('qVendor', e.target.value)}><option value="">Choose…</option>{approvedVendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</select></Field>
              <Field label={`Amount (${cur})`}><input required inputMode="decimal" value={f('qAmount')} onChange={(e) => setF('qAmount', e.target.value)} /></Field>
              <Field label="Lead time (days)"><input inputMode="numeric" value={f('qDays')} onChange={(e) => setF('qDays', e.target.value)} /></Field>
              <Field label="Notes"><input value={f('qNotes')} onChange={(e) => setF('qNotes', e.target.value)} /></Field>
              <div className="mx__field--wide"><button type="submit" className="mx__btn mx__btn--sm">Record quote</button></div>
            </form>}
            {panel === 'seal' && <form className="mx__form pr__form" onSubmit={(e) => { e.preventDefault(); void act(r.id, async () => { await postJson(`/api/procurement/requests/${r.id}/deadline`, { opensAt: new Date(f('opensAt')).toISOString() }); setPanel(null); setQuotes(await get(`/api/procurement/requests/${r.id}/quotes`)); return 'Quotes are sealed until the deadline.'; }); }}>
              <Field label="Open quotes after"><input type="datetime-local" required value={f('opensAt')} onChange={(e) => setF('opensAt', e.target.value)} /><small className="mx__tiny">Amounts stay hidden from everyone until the deadline passes and someone opens them.</small></Field>
              <div className="mx__field--wide"><button type="submit" className="mx__btn mx__btn--sm">Seal</button></div>
            </form>}
            {panel === 'order' && <form className="mx__form pr__form" onSubmit={(e) => { e.preventDefault(); void act(r.id, async () => { const o = await postJson<{ number: number; status: string }>('/api/procurement/orders', { requisitionId: r.id, vendorId: f('oVendor'), expectedBy: f('oBy'), deliveryLocation: f('oWhere'), exceptionReason: f('oException'), lines: lineBody() }); setOpen(null); setPanel(null); return o.status === 'pending_approval' ? `Order ${o.number} raised; it is over the request by more than the tolerance and needs approval.` : `Order ${o.number} issued.`; }); }}>
              <Field label="Supplier"><select required value={f('oVendor')} onChange={(e) => setF('oVendor', e.target.value)}><option value="">Choose…</option>{approvedVendors.map((v) => <option key={v.id} value={v.id}>{v.name}{v.status !== 'approved' ? ` (${v.status})` : ''}</option>)}</select></Field>
              <Field label="Expected by"><input type="date" value={f('oBy')} onChange={(e) => setF('oBy', e.target.value)} /></Field>
              <Field label="Deliver to"><input value={f('oWhere')} onChange={(e) => setF('oWhere', e.target.value)} /></Field>
              <Field label="Exception reason (restricted or suspended supplier)"><input value={f('oException')} onChange={(e) => setF('oException', e.target.value)} /></Field>
              {lineEditor(`ol-${r.id}`)}
              <div className="mx__field--wide"><button type="submit" className="mx__btn" disabled={busy === r.id}>Raise order</button></div>
            </form>}
          </div>}
        </div>; })}
        {reqs.data && !toOrder.length && <EmptyState icon="inbox" title="Nothing to order" text="Approved purchase requests arrive here. Record quotes, choose one, then raise the order to an approved supplier." />}</div>
      </div>}

      {tab === 'orders' && <div className="mx__card"><div className="mx__cardHead"><h3>Orders</h3><div className="mx__segs">{seg('open', orderFilter, setOrderFilter, 'Open')}{seg('all', orderFilter, setOrderFilter, 'All')}</div></div>
        <div className="ex__records">{orderList.map((o) => { const isOpen = open === o.id; const d = isOpen ? detail : null; return <div key={o.id} className={`ex__record ${isOpen ? 'is-open' : ''}`}>
          <div className="ex__recordHead">
            <Avatar name={o.vendor_name} text={`#${o.number}`} />
            <div className="mx__main">
              <strong>{o.vendor_name} <Pill s={o.status} text={ORDER_WORDS[o.status] ?? words(o.status)} />{o.revision > 1 && <Pill s="draft" text={`Revision ${o.revision}`} />}</strong>
              <small>Order {o.number}{o.requisition_reference ? ` · for ${o.requisition_reference}` : ''}{o.agreement_title ? ` · under "${o.agreement_title}"` : ''}{o.expected_by ? ` · expected ${day(o.expected_by)}` : ''}{o.created_by_name ? ` · by ${o.created_by_name}` : ''}</small>
              {o.exception_reason && <small className="ex__bank is-off">Exception: {o.exception_reason}</small>}
            </div>
            <div className="ex__amount"><strong>{money(o.total, o.currency)}</strong><small>ordered</small></div>
          </div>
          <div className="ex__recordBtns">
            <button type="button" className="mx__btn mx__btn--sm" aria-expanded={isOpen} onClick={() => void toggleOrder(o)}>{isOpen ? 'Close' : 'Open'}</button>
            {o.status === 'pending_approval' && canAdminister && <button type="button" className="mx__btn mx__btn--sm" onClick={() => void act(o.id, async () => { await postJson(`/api/procurement/orders/${o.id}/approve`, {}); return `Order ${o.number} approved and issued.`; })}>Approve</button>}
            {!['cancelled', 'closed'].includes(o.status) && <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => ask(o.id, 'Why cancel this order?', async (reason) => { await postJson(`/api/procurement/orders/${o.id}/cancel`, { reason }); return `Order ${o.number} cancelled; the budget is released.`; })}>Cancel order</button>}
          </div>
          {d && <div className="pr__panel">
            <table className="ex__table"><thead><tr><th scope="col">Line</th><th scope="col">Ordered</th><th scope="col">Accepted</th><th scope="col">Rejected</th><th scope="col">Still to come</th><th scope="col">To invoice</th></tr></thead>
              <tbody>{d.lines.map((l) => <tr key={l.id}><td>{l.lineNo}. {l.description} @ {l.unitPrice}</td><td>{l.quantity}</td><td>{l.netAccepted}{l.returned ? ` (${l.returned} returned)` : ''}</td><td>{l.rejected}</td><td>{l.toCome}</td><td>{l.toInvoice}</td></tr>)}</tbody></table>
            <div className="ex__recordBtns">
              {['issued', 'partially_received'].includes(d.status) && panelBtn('receive', 'Record a delivery', true)}
              {!['cancelled', 'closed', 'pending_approval'].includes(d.status) && d.lines.some((l) => l.toInvoice > 0) && panelBtn('invoice', 'Enter the supplier’s invoice')}
              {['issued', 'pending_approval', 'partially_received'].includes(d.status) && panelBtn('revise', 'Change the order')}
            </div>
            {panel === 'receive' && <form className="mx__form pr__form" onSubmit={(e) => { e.preventDefault(); void act(o.id, async () => { const body = { evidenceRef: f('ev'), lines: d.lines.filter((l) => qty[l.id] && (Number(qty[l.id]!.a) > 0 || Number(qty[l.id]!.r) > 0)).map((l) => ({ lineId: l.id, accepted: Number(qty[l.id]!.a || 0), rejected: Number(qty[l.id]!.r || 0), reason: qty[l.id]!.why })) }; const done = await postJson<{ status: string }>(`/api/procurement/orders/${o.id}/receive`, body); setOpen(null); setPanel(null); return `Delivery recorded: ${ORDER_WORDS[done.status]}.`; }); }}>
              <div className="mx__field--wide"><small className="mx__tiny">Approving an order does not prove anything arrived. Count what came.</small></div>
              {d.lines.filter((l) => l.toCome > 0).map((l) => <div key={l.id} className="mx__field--wide pr__lineRow">
                <span className="pr__lineName">{l.lineNo}. {l.description}<small className="mx__tiny">{l.toCome} to come</small></span>
                <label htmlFor={`ra-${l.id}`}>Accepted</label><input id={`ra-${l.id}`} className="mx__input pr__num" inputMode="decimal" value={qty[l.id]?.a ?? ''} onChange={(e) => setQty({ ...qty, [l.id]: { ...(qty[l.id] ?? { a: '', r: '', why: '' }), a: e.target.value } })} />
                <label htmlFor={`rr-${l.id}`}>Rejected</label><input id={`rr-${l.id}`} className="mx__input pr__num" inputMode="decimal" value={qty[l.id]?.r ?? ''} onChange={(e) => setQty({ ...qty, [l.id]: { ...(qty[l.id] ?? { a: '', r: '', why: '' }), r: e.target.value } })} />
                <label htmlFor={`rw-${l.id}`}>Why rejected</label><input id={`rw-${l.id}`} className="mx__input" value={qty[l.id]?.why ?? ''} onChange={(e) => setQty({ ...qty, [l.id]: { ...(qty[l.id] ?? { a: '', r: '', why: '' }), why: e.target.value } })} />
              </div>)}
              <Field label="Delivery note or photo reference" wide><input value={f('ev')} onChange={(e) => setF('ev', e.target.value)} /></Field>
              <div className="mx__field--wide"><button type="submit" className="mx__btn">Record delivery</button></div>
            </form>}
            {panel === 'invoice' && <form className="mx__form pr__form" onSubmit={(e) => { e.preventDefault(); void act(o.id, async () => { const body = { orderId: o.id, invoiceNo: f('invNo'), invoiceDate: f('invDate'), lines: d.lines.filter((l) => qty[`i-${l.id}`] && Number(qty[`i-${l.id}`]!.a) > 0).map((l) => ({ lineId: l.id, quantity: Number(qty[`i-${l.id}`]!.a), unitPrice: Number(qty[`i-${l.id}`]!.price ?? l.unitPrice) })) }; const done = await postJson<{ status: string; mismatches: string[] }>('/api/procurement/invoices', body); setOpen(null); setPanel(null); return done.status === 'held' ? `Invoice held: ${done.mismatches.join('; ')}` : 'Invoice matched and approved to pay.'; }); }}>
              <div className="mx__field--wide"><small className="mx__tiny">It is matched against what was accepted and the order price. A mismatch holds it with the reason.</small></div>
              <Field label="Invoice number"><input required value={f('invNo')} onChange={(e) => setF('invNo', e.target.value)} /></Field>
              <Field label="Invoice date"><input type="date" required value={f('invDate')} onChange={(e) => setF('invDate', e.target.value)} /></Field>
              {d.lines.map((l) => <div key={l.id} className="mx__field--wide pr__lineRow">
                <span className="pr__lineName">{l.lineNo}. {l.description}<small className="mx__tiny">{l.toInvoice} to invoice</small></span>
                <label htmlFor={`iq-${l.id}`}>Quantity</label><input id={`iq-${l.id}`} className="mx__input pr__num" inputMode="decimal" value={qty[`i-${l.id}`]?.a ?? ''} onChange={(e) => setQty({ ...qty, [`i-${l.id}`]: { ...(qty[`i-${l.id}`] ?? { a: '', r: '', why: '' }), a: e.target.value } })} />
                <label htmlFor={`ip-${l.id}`}>Unit price</label><input id={`ip-${l.id}`} className="mx__input pr__num" inputMode="decimal" placeholder={String(l.unitPrice)} value={qty[`i-${l.id}`]?.price ?? ''} onChange={(e) => setQty({ ...qty, [`i-${l.id}`]: { ...(qty[`i-${l.id}`] ?? { a: '', r: '', why: '' }), price: e.target.value } })} />
              </div>)}
              <div className="mx__field--wide"><button type="submit" className="mx__btn">Enter invoice</button></div>
            </form>}
            {panel === 'revise' && <form className="mx__form pr__form" onSubmit={(e) => { e.preventDefault(); void act(o.id, async () => { const done = await postJson<{ status: string; revision: number }>(`/api/procurement/orders/${o.id}/revise`, { reason: f('revWhy'), lines: lineBody() }); setOpen(null); setPanel(null); return done.status === 'pending_approval' ? `Revision ${done.revision} needs approval by someone else.` : `Revision ${done.revision} saved.`; }); }}>
              <div className="mx__field--wide"><small className="mx__tiny">A new revision. An increase past the tolerance goes back for approval.</small></div>
              {lineEditor(`rv-${o.id}`)}
              <Field label="Why it is changing" wide><input required value={f('revWhy')} onChange={(e) => setF('revWhy', e.target.value)} /></Field>
              <div className="mx__field--wide"><button type="submit" className="mx__btn">Save revision</button></div>
            </form>}
            {d.revisions.length > 1 && <ul className="mx__list" style={{ marginTop: 10 }}>{d.revisions.map((r) => <li key={r.revision}><span className="mx__avatar" style={{ marginLeft: 0, fontSize: 10 }}>R{r.revision}</span><div className="mx__main"><strong>{money(r.total, cur)}</strong><small>{r.reason ?? ''}{r.actor_name ? ` · ${r.actor_name}` : ''} · {day(r.occurred_at)}</small></div></li>)}</ul>}
          </div>}
        </div>; })}
        {orders.data && !orderList.length && <EmptyState icon="send" title="No orders" text="Raise an order from an approved request. Record what arrives, then enter the supplier's invoice against it." />}</div>
      </div>}

      {tab === 'invoices' && <div className="mx__card"><div className="mx__cardHead"><h3>Supplier invoices</h3><div className="mx__bar"><div className="mx__segs">{seg('open', invoiceFilter, setInvoiceFilter, 'Held and to pay')}{seg('all', invoiceFilter, setInvoiceFilter, 'All')}</div><button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" disabled={busy === 'export'} onClick={() => void act('export', async () => { const out = await postJson<{ invoices: number; total: number; filename: string; csv: string }>('/api/procurement/invoices/export', {}); const url = URL.createObjectURL(new Blob([out.csv], { type: 'text/csv;charset=utf-8' })); const a = document.createElement('a'); a.href = url; a.download = out.filename; a.click(); URL.revokeObjectURL(url); return `Exported ${out.invoices} paid invoices (${money(out.total, cur)}).`; })}>Export paid invoices</button></div></div>
        <div className="ex__records">{invoiceList.map((i) => <div key={i.id} className="ex__record">
          <div className="ex__recordHead">
            <Avatar name={i.vendor_name} />
            <div className="mx__main">
              <strong>{i.vendor_name} <Pill s={i.status} text={INVOICE_WORDS[i.status] ?? i.status} /></strong>
              <small>{i.invoice_no} · order {i.order_number} · dated {day(i.invoice_date)} · entered by {i.entered_by_name}{i.payment_ref ? ` · paid, ref ${i.payment_ref}` : ''}{i.review_reason ? ` · decision: ${i.review_reason}` : ''}</small>
              {i.mismatches.map((m) => <small key={m} className="ex__bank is-off">✕ {m}</small>)}
              {i.status === 'approved' && !i.bank_verified && <small className="ex__bank is-off">The supplier&rsquo;s bank details are not checked; payment is blocked.</small>}
            </div>
            <div className="ex__amount"><strong>{money(i.total, i.currency)}</strong><small>{i.status === 'paid' ? 'paid' : 'invoiced'}</small></div>
          </div>
          {(i.status === 'held' && canAdminister || i.status === 'approved') && <div className="ex__recordBtns">
            {i.status === 'held' && canAdminister && <>
              <button type="button" className="mx__btn mx__btn--sm" onClick={() => ask(i.id, 'Why approve despite the mismatch?', async (reason) => { await postJson(`/api/procurement/invoices/${i.id}/review`, { decision: 'approve', reason }); return 'Approved with your reason recorded.'; })}>Approve anyway</button>
              <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => ask(i.id, 'Why reject this invoice?', async (reason) => { await postJson(`/api/procurement/invoices/${i.id}/review`, { decision: 'reject', reason }); return 'Invoice rejected.'; })}>Reject</button>
            </>}
            {i.status === 'approved' && <button type="button" className="mx__btn mx__btn--sm" disabled={!i.bank_verified} onClick={() => ask(i.id, 'Payment reference', async (reference) => { await postJson(`/api/procurement/invoices/${i.id}/pay`, { reference }); return 'Payment recorded.'; })}>Record payment</button>}
          </div>}
        </div>)}
        {invoices.data && !invoiceList.length && <EmptyState icon="register" title={invoiceFilter === 'all' ? 'No invoices yet' : 'Nothing held or waiting to pay'} text="Enter an invoice from its order. Someone other than whoever entered it decides on a mismatch; payment needs the supplier's bank details checked." />}</div>
      </div>}

      {tab === 'suppliers' && <div className="mx__card"><div className="mx__cardHead"><h3>Suppliers</h3><button type="button" className="mx__btn mx__btn--sm" onClick={() => setAdding(adding === 'vendor' ? null : 'vendor')}>{adding === 'vendor' ? 'Close' : '+ Add a supplier'}</button></div>
        {adding === 'vendor' && <div className="mx__cardBody"><form className="mx__form" onSubmit={(e) => { e.preventDefault(); void act('vendor', async () => { await postJson('/api/procurement/vendors', { ...vendorForm, categories: (vendorForm.categories ?? '').split(',').map((c) => c.trim()).filter(Boolean) }); setVendorForm({}); setAdding(null); return 'Supplier added as a draft. Send it for review, then an admin approves it.'; }); }}>
          {([['name', 'Name'], ['registrationNo', 'Registration number'], ['taxId', 'Tax ID'], ['contactName', 'Contact name'], ['contactEmail', 'Contact email'], ['contactPhone', 'Contact phone'], ['categories', 'Categories (comma separated)'], ['documentsRef', 'Where their documents are']] as const).map(([k, label]) => <Field key={k} label={label}><input required={k === 'name'} value={vendorForm[k] ?? ''} onChange={(e) => setVendorForm({ ...vendorForm, [k]: e.target.value })} /></Field>)}
          <div className="mx__field--wide"><button type="submit" className="mx__btn" disabled={busy === 'vendor'}>Add supplier</button></div>
        </form></div>}
        <div className="hr__people">{(vendors.data ?? []).map((v) => {
          const onTime = v.delivered_with_date ? Math.round((v.on_time / v.delivered_with_date) * 100) : null;
          const rejectedPct = Number(v.delivered_qty) ? Math.round((Number(v.rejected_qty) / Number(v.delivered_qty)) * 100) : null;
          return <div key={v.id} className={`hr__person pr__vendor ${open === v.id ? 'is-open' : ''}`}>
            <Avatar name={v.name} />
            <div className="mx__main">
              <strong>{v.name} <Pill s={v.status} /></strong>
              <small>{[v.tax_id && `Tax ID ${v.tax_id}`, v.contact_name, v.contact_email, (v.categories ?? []).join(', ')].filter(Boolean).join(' · ') || 'No contact details yet'}</small>
              {v.status_reason && <small className="ex__bank is-off">{v.status_reason}</small>}
              <div className="pr__stats"><span><strong>{v.orders}</strong><small>orders</small></span><span><strong>{onTime !== null ? `${onTime}%` : '–'}</strong><small>on time</small></span><span><strong>{rejectedPct !== null ? `${rejectedPct}%` : '–'}</strong><small>rejected</small></span><span><strong>{v.invoices_held}</strong><small>held</small></span></div>
              <small className={`ex__bank ${v.bank_verified ? 'is-ok' : 'is-off'}`}>{v.bank_last4 ? `Bank: ${v.bank_name} •••• ${v.bank_last4} — ${v.bank_verified ? 'checked' : 'not checked'}` : 'No bank details yet'}{revealed[v.id] ? ` · full number ${revealed[v.id]}` : ''}</small>
            </div>
            <div className="ex__recordBtns" style={{ gridColumn: '1 / -1' }}>
              {v.status === 'draft' && <button type="button" className="mx__btn mx__btn--sm" onClick={() => void act(v.id, async () => { await postJson(`/api/procurement/vendors/${v.id}/status`, { to: 'under_review' }); return `${v.name} sent for review.`; })}>Send for review</button>}
              {['under_review', 'restricted', 'suspended'].includes(v.status) && canAdminister && <button type="button" className="mx__btn mx__btn--sm" onClick={() => void act(v.id, async () => { await postJson(`/api/procurement/vendors/${v.id}/status`, { to: 'approved' }); return `${v.name} approved.`; })}>Approve</button>}
              {['approved', 'restricted'].includes(v.status) && <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => ask(v.id, `Why suspend ${v.name}?`, async (reason) => { await postJson(`/api/procurement/vendors/${v.id}/status`, { to: 'suspended', reason }); return `${v.name} suspended.`; })}>Suspend</button>}
              <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" aria-expanded={open === v.id} onClick={() => { setForm({}); setOpen(open === v.id ? null : v.id); }}>{v.bank_last4 ? 'Change bank details' : 'Add bank details'}</button>
              {v.bank_last4 && !v.bank_verified && <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => void act(v.id, async () => { await postJson(`/api/procurement/vendors/${v.id}/bank/verify`, {}); return 'Bank details checked.'; })}>Mark bank checked</button>}
              {v.bank_last4 && !revealed[v.id] && <button type="button" className="mx__btn mx__btn--ghost mx__btn--sm" onClick={() => void act(v.id, async () => { const b = await postJson<{ accountNumber: string }>(`/api/procurement/vendors/${v.id}/bank/reveal`, {}); setRevealed({ ...revealed, [v.id]: b.accountNumber }); return 'Shown. Viewing is recorded.'; })}>Show full number</button>}
            </div>
            {open === v.id && <form className="mx__form pr__form" style={{ gridColumn: '1 / -1' }} onSubmit={(e) => { e.preventDefault(); void act(v.id, async () => { await postJson(`/api/procurement/vendors/${v.id}/bank`, { accountName: f('bName'), bankName: f('bBank'), bankCode: f('bCode'), accountNumber: f('bNo') }); setForm({}); setOpen(null); return 'Bank details saved. Someone else must check them before any payment.'; }); }}>
              <Field label="Account name"><input required value={f('bName')} onChange={(e) => setF('bName', e.target.value)} /></Field>
              <Field label="Bank"><input required value={f('bBank')} onChange={(e) => setF('bBank', e.target.value)} /></Field>
              <Field label="Bank or sort code"><input value={f('bCode')} onChange={(e) => setF('bCode', e.target.value)} /></Field>
              <Field label="Account number"><input required autoComplete="off" value={f('bNo')} onChange={(e) => setF('bNo', e.target.value)} /></Field>
              <div className="mx__field--wide"><button type="submit" className="mx__btn mx__btn--sm">Save bank details</button><small className="mx__tiny" style={{ marginLeft: 12 }}>Someone other than you must check them before payment.</small></div>
            </form>}
          </div>;
        })}
        {vendors.data && !vendors.data.length && <EmptyState icon="people" title="No suppliers yet" text="Add a supplier, send it for review, and an admin approves it. Orders go only to approved suppliers." action={{ label: 'Add a supplier', onClick: () => setAdding('vendor') }} />}</div>
      </div>}

      {tab === 'agreements' && <div className="mx__card"><div className="mx__cardHead"><h3>Framework agreements</h3>{canAdminister && <button type="button" className="mx__btn mx__btn--sm" onClick={() => setAdding(adding === 'agreement' ? null : 'agreement')}>{adding === 'agreement' ? 'Close' : '+ Add an agreement'}</button>}</div>
        {adding === 'agreement' && canAdminister && <div className="mx__cardBody"><form className="mx__form" onSubmit={(e) => { e.preventDefault(); void act('agreement', async () => { await postJson('/api/procurement/agreements', { vendorId: f('gVendor'), title: f('gTitle'), limitAmount: f('gLimit'), validFrom: f('gFrom'), validTo: f('gTo') }); setForm({}); setAdding(null); return 'Agreement saved.'; }); }}>
          <Field label="Supplier"><select required value={f('gVendor')} onChange={(e) => setF('gVendor', e.target.value)}><option value="">Choose…</option>{(vendors.data ?? []).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</select></Field>
          <Field label="Title"><input required value={f('gTitle')} onChange={(e) => setF('gTitle', e.target.value)} /></Field>
          <Field label={`Limit (${cur})`}><input required inputMode="decimal" value={f('gLimit')} onChange={(e) => setF('gLimit', e.target.value)} /></Field>
          <Field label="From"><input type="date" required value={f('gFrom')} onChange={(e) => setF('gFrom', e.target.value)} /></Field>
          <Field label="To"><input type="date" required value={f('gTo')} onChange={(e) => setF('gTo', e.target.value)} /></Field>
          <div className="mx__field--wide"><button type="submit" className="mx__btn">Save agreement</button><small className="mx__tiny" style={{ marginLeft: 12 }}>Orders under it use up its limit; nothing can go over.</small></div>
        </form></div>}
        <div className="ex__budgets">{(agreements.data ?? []).map((g) => <div key={g.id} className="ex__budget">
          <div className="ex__budgetHead"><strong>{g.title}</strong><Pill s="approved" text={g.vendor_name} /></div>
          <small className="mx__tiny">{day(g.valid_from)} to {day(g.valid_to)}</small>
          <div className="ex__budgetBig"><strong style={{ color: g.remaining <= 0 ? '#c0392b' : undefined }}>{money(g.remaining, cur)}</strong><small>left of {money(g.limit_amount, cur)}</small></div>
          <Bar value={Number(g.used)} max={Number(g.limit_amount)} warn={g.remaining <= 0} />
          <small className="mx__tiny">{short(g.used)} used</small>
        </div>)}
        {agreements.data && !agreements.data.length && <EmptyState icon="templates" title="No agreements" text="A framework agreement caps what can be ordered from a supplier over a period. Orders under it draw down the limit." action={canAdminister ? { label: 'Add an agreement', onClick: () => setAdding('agreement') } : undefined} />}</div>
      </div>}

      {tab === 'budgets' && <div className="mx__card"><div className="mx__cardHead"><h3>Budgets by cost centre</h3><small>shared with Expenses: one budget covers claims and purchases</small></div>
        <div className="ex__budgets">{(budgets.data ?? []).map((b) => { const used = Number(b.consumed) + Number(b.reserved); return <div key={b.id} className="ex__budget">
          <div className="ex__budgetHead"><strong>{b.cost_centre}</strong><Pill s={b.mode} text={b.mode === 'enforced' ? 'Enforced' : 'Advisory'} /></div>
          <small className="mx__tiny">{day(b.period_start)} to {day(b.period_end)}</small>
          <div className="ex__budgetBig"><strong style={{ color: b.available < 0 ? '#c0392b' : undefined }}>{money(b.available, cur)}</strong><small>left of {money(b.amount, cur)}</small></div>
          <Bar value={used} max={Number(b.amount)} warn={b.available < 0} />
          <small className="mx__tiny">{short(b.consumed)} committed · {short(b.reserved)} in requests</small>
        </div>; })}
        {budgets.data && !budgets.data.length && <EmptyState icon="check" title="No budgets yet" text="Owners and admins set budgets on the Expenses page. One budget per cost centre covers both claims and purchases." />}</div>
      </div>}

      {tab === 'rules' && ruleDraft && <div className="mx__card"><div className="mx__cardHead"><h3>Procurement rules</h3><small>amounts in {cur} · new requests use these from now on</small></div>
        <div className="mx__cardBody"><form className="mx__form" onSubmit={(e) => { e.preventDefault(); void act('rules', async () => { await postJson('/api/procurement/settings', ruleDraft); await rules.reload(); return 'Rules saved.'; }); }}>
          {([['managerLimit', 'A manager alone approves requests up to'], ['priceTolerancePct', 'Invoice price may be above the order price by (%)'], ['amountTolerance', 'Invoice total may be above the order by'], ['orderIncreasePct', 'An order may exceed its request by (%) before re-approval'], ['quotesRequired', 'Quotes needed'], ['quotesRequiredOver', 'for requests over']] as const).map(([k, label]) => <Field key={k} label={label}><input inputMode="decimal" disabled={!canAdminister} value={String(ruleDraft[k])} onChange={(e) => setRuleDraft({ ...ruleDraft, [k]: Number(e.target.value) })} /></Field>)}
          <Field label="Before paying a supplier" wide><div className="mx__segs"><button type="button" className={`mx__seg ${ruleDraft.requireVendorBankCheck ? 'is-on' : ''}`} disabled={!canAdminister} onClick={() => setRuleDraft({ ...ruleDraft, requireVendorBankCheck: true })}>Bank details must be checked</button><button type="button" className={`mx__seg ${!ruleDraft.requireVendorBankCheck ? 'is-on' : ''}`} disabled={!canAdminister} onClick={() => setRuleDraft({ ...ruleDraft, requireVendorBankCheck: false })}>No check needed</button></div></Field>
          <div className="mx__field--wide">{canAdminister ? <button type="submit" className="mx__btn" disabled={busy === 'rules'}>Save rules</button> : <small className="mx__tiny">Only owners and admins can change the rules.</small>}</div>
        </form></div>
      </div>}
    </div>
  </div>;
}
