'use client';

import { useCallback, useEffect, useState } from 'react';
import { Icon } from './Icon';
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
const day = (v: string | null | undefined) => (v ? new Date(v).toLocaleDateString() : '');
const list = { listStyle: 'none', margin: 0, padding: 0 } as const;
const words = (s: string) => s.replace(/_/g, ' ');

const ORDER_WORDS: Record<string, string> = { pending_approval: 'Waiting for approval', issued: 'Ordered, nothing received', partially_received: 'Partly received', received: 'All received', closed: 'Closed', cancelled: 'Cancelled' };
const INVOICE_WORDS: Record<string, string> = { held: 'Held — mismatch', approved: 'Approved to pay', paid: 'Paid', rejected: 'Rejected', void: 'Void' };

function Field({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return <div><label className="cs__label" htmlFor={id}>{label}</label>{children}</div>;
}

export function ProcurementView({ canAdminister, canOperate, onOpenRecord }: { canAdminister: boolean; canOperate: boolean; onOpenRecord: (instanceId: string) => void }) {
  const [tab, setTab] = useState<Tab>('requests');
  const on = canOperate;
  const summary = useFeed<Summary>(on ? '/api/procurement/summary' : null);
  const reqs = useFeed<Req[]>(on ? '/api/procurement/requests' : null);
  const orders = useFeed<Order[]>(on ? '/api/procurement/orders' : null);
  const invoices = useFeed<Invoice[]>(on ? '/api/procurement/invoices' : null);
  const vendors = useFeed<Vendor[]>(on ? '/api/procurement/vendors' : null);
  const agreements = useFeed<Agreement[]>(on ? '/api/procurement/agreements' : null);
  const budgets = useFeed<Budget[]>(on ? '/api/expenses/budgets' : null);
  const rules = useFeed<Rules>(on ? '/api/procurement/settings' : null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [quotes, setQuotes] = useState<{ sealed: boolean; opensAt: string | null; quotes: Quote[] } | null>(null);
  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [lines, setLines] = useState<{ description: string; quantity: string; unitPrice: string }[]>([{ description: '', quantity: '1', unitPrice: '' }]);
  const [qty, setQty] = useState<Record<string, { a: string; r: string; why: string; price?: string }>>({});
  const [vendorForm, setVendorForm] = useState<Record<string, string>>({});
  const [ruleDraft, setRuleDraft] = useState<Rules | null>(null);
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  // A reason or reference asked for inline, never with a browser pop-up.
  const [asking, setAsking] = useState<{ id: string; label: string; run: (answer: string) => Promise<string> } | null>(null);
  const [answer, setAnswer] = useState('');
  useEffect(() => { if (rules.data) setRuleDraft(rules.data); }, [rules.data]);

  const cur = summary.data?.currency ?? rules.data?.currency ?? '';
  const f = (k: string) => form[k] ?? '';
  const setF = (k: string, v: string) => setForm((x) => ({ ...x, [k]: v }));
  const reloadAll = async () => { await Promise.all([summary.reload(), reqs.reload(), orders.reload(), invoices.reload(), vendors.reload(), agreements.reload(), budgets.reload()]); };
  const act = async (id: string, work: () => Promise<string>) => {
    setBusy(id); setNote(null);
    try { setNote(await work()); await reloadAll(); }
    catch (err) { setNote(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(null); }
  };
  const toggleReq = async (r: Req) => {
    if (open === r.id) { setOpen(null); return; }
    setOpen(r.id); setForm({}); setQuotes(await get(`/api/procurement/requests/${r.id}/quotes`));
    setLines([{ description: r.title ?? '', quantity: '1', unitPrice: '' }]);
  };
  const toggleOrder = async (o: Order) => {
    if (open === o.id) { setOpen(null); return; }
    setOpen(o.id); setForm({}); setQty({});
    const d = await get<OrderDetail>(`/api/procurement/orders/${o.id}`);
    setDetail(d);
    setLines(d.lines.map((l) => ({ description: l.description, quantity: String(l.quantity), unitPrice: String(l.unitPrice) })));
  };
  const lineEditor = (prefix: string) => <div style={{ gridColumn: '1 / -1' }}>
    <table className="ex__table"><thead><tr><th scope="col">Item</th><th scope="col">Quantity</th><th scope="col">Unit price ({cur})</th><th scope="col"><span className="ex__sr">Remove</span></th></tr></thead>
      <tbody>{lines.map((l, i) => <tr key={i}>
        <td><label className="ex__sr" htmlFor={`${prefix}-d-${i}`}>Item {i + 1}</label><input id={`${prefix}-d-${i}`} className="cs__input" value={l.description} onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, description: e.target.value } : x))} /></td>
        <td><label className="ex__sr" htmlFor={`${prefix}-q-${i}`}>Quantity {i + 1}</label><input id={`${prefix}-q-${i}`} className="cs__input" inputMode="decimal" value={l.quantity} onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, quantity: e.target.value } : x))} /></td>
        <td><label className="ex__sr" htmlFor={`${prefix}-p-${i}`}>Unit price {i + 1}</label><input id={`${prefix}-p-${i}`} className="cs__input" inputMode="decimal" value={l.unitPrice} onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, unitPrice: e.target.value } : x))} /></td>
        <td>{lines.length > 1 && <button type="button" className="cs__btn" onClick={() => setLines(lines.filter((_, j) => j !== i))}>Remove</button>}</td>
      </tr>)}</tbody></table>
    <button type="button" className="cs__btn" onClick={() => setLines([...lines, { description: '', quantity: '1', unitPrice: '' }])}>Add a line</button>
    <p className="dim__note">Order total: {money(lines.reduce((s, l) => s + Number(l.quantity || 0) * Number(l.unitPrice || 0), 0), cur)}</p>
  </div>;
  const lineBody = () => lines.map((l) => ({ description: l.description, quantity: Number(l.quantity), unitPrice: Number(l.unitPrice) }));
  const approvedVendors = (vendors.data ?? []).filter((v) => !['draft', 'under_review', 'archived'].includes(v.status));

  if (!on) return <div className="ig__workspace"><header className="ig__hero"><span className="ig__eyebrow">PROCUREMENT</span><h2>Buying for the organisation</h2><p>To ask for something to be bought, use the Purchase request form. Procurement staff manage suppliers, orders and invoices here.</p></header></div>;

  const s = summary.data;
  const tabs: { id: Tab; name: string; count: number | null; icon: 'table' | 'export' | 'trail' | 'account' | 'done' }[] = [
    { id: 'requests', name: 'To order', count: s?.toOrder ?? 0, icon: 'table' },
    { id: 'orders', name: 'Orders', count: (s?.ordersPending ?? 0) + (s?.ordersOpen ?? 0), icon: 'export' },
    { id: 'invoices', name: 'Invoices', count: (s?.invoicesHeld ?? 0) + (s?.invoicesToPay ?? 0), icon: 'trail' },
    { id: 'suppliers', name: 'Suppliers', count: vendors.data?.length ?? 0, icon: 'account' },
    { id: 'agreements', name: 'Agreements', count: agreements.data?.length ?? 0, icon: 'done' },
    { id: 'budgets', name: 'Budgets', count: budgets.data?.length ?? 0, icon: 'done' },
    { id: 'rules', name: 'Rules', count: null, icon: 'trail' },
  ];
  const error = ({ requests: reqs.error, orders: orders.error, invoices: invoices.error, suppliers: vendors.error, agreements: agreements.error, budgets: budgets.error, rules: rules.error } as Record<Tab, string | null>)[tab] ?? summary.error;

  return <div className="ig__workspace">
    <header className="ig__hero">
      <span className="ig__eyebrow">PROCUREMENT</span>
      <h2>From approved request to paid invoice</h2>
      <p>Order from approved suppliers, record what actually arrived, and pay only for what was accepted. Mismatched invoices wait here with the reason.</p>
    </header>

    {s && <section className="pp2__overview" aria-label="Procurement at a glance" style={{ marginBottom: 18 }}>
      <div><span>Requests to order</span><strong>{s.toOrder}</strong><small>{s.ordersPending} orders waiting for approval</small></div>
      <div><span>Invoices held</span><strong>{s.invoicesHeld}</strong><small>{s.invoicesToPay} approved to pay · {money(s.toPayAmount, s.currency)}</small></div>
      <div><span>Suppliers to review</span><strong>{s.vendorsToReview}</strong><small>{s.banksUnchecked} bank details to check</small></div>
    </section>}

    <div className="ig__surface">
      <div className="ig__tabs" role="tablist" aria-label="Procurement areas">
        {tabs.map((item, index) => <button key={item.id} id={`pr-tab-${item.id}`} type="button" role="tab" aria-controls={`pr-panel-${item.id}`} aria-selected={tab === item.id} tabIndex={tab === item.id ? 0 : -1} className="ig__tab" onClick={() => { setTab(item.id); setOpen(null); setNote(null); setForm({}); }} onKeyDown={(event) => { const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index - 1 + tabs.length) % tabs.length : -1; if (next < 0) return; event.preventDefault(); const id = tabs[next]!.id; setTab(id); setOpen(null); document.getElementById(`pr-tab-${id}`)?.focus(); }}>
          <Icon name={item.icon} /><span>{item.name}</span>{item.count !== null && <span className="ig__tabCount">{item.count}</span>}
        </button>)}
      </div>

      <section id={`pr-panel-${tab}`} role="tabpanel" aria-labelledby={`pr-tab-${tab}`} className="ig__panel">
        {note && <p className="ig__notice" role="status">{note}</p>}
        {error && <p className="ig__error" role="alert">{error}</p>}
        {asking && <form className="ig__form" onSubmit={(e) => { e.preventDefault(); const a = answer.trim(); if (!a) return; const job = asking; setAsking(null); setAnswer(''); void act(job.id, () => job.run(a)); }}>
          <Field id="pr-ask" label={asking.label}><input id="pr-ask" className="cs__input" required autoFocus value={answer} onChange={(e) => setAnswer(e.target.value)} /></Field>
          <div className="pp2__roleEdit" style={{ alignSelf: 'end' }}><button type="submit" className="cs__btn cs__btn--primary">Save</button><button type="button" className="cs__btn" onClick={() => { setAsking(null); setAnswer(''); }}>Cancel</button></div>
        </form>}

        {tab === 'requests' && <ul style={list}>
          {(reqs.data ?? []).filter((r) => r.status === 'approved' || r.status === 'sourcing').map((r) => <li key={r.id} className="ig__row" style={{ flexWrap: 'wrap' }}>
            <div className="ig__rowMain">
              <strong>{r.reference} · {r.title ?? 'Request'}</strong><span className="ig__status ig__status--off">{r.status === 'sourcing' ? `${r.quotes} quote(s)` : 'Approved'}</span>
              <p>{r.requester_name} · {money(r.amount, r.currency)} estimated · {r.cost_centre ?? ''}{r.needed_by ? ` · needed by ${day(r.needed_by)}` : ''}</p>
              {open === r.id && quotes && <div className="ex__lines">
                <strong>Quotes</strong>
                {quotes.sealed && <p className="dim__note">Sealed until {new Date(quotes.opensAt!).toLocaleString()}: amounts are hidden. {new Date(quotes.opensAt!) < new Date() && <button type="button" className="cs__btn" onClick={() => void act(r.id, async () => { await postJson(`/api/procurement/requests/${r.id}/open-quotes`, {}); setQuotes(await get(`/api/procurement/requests/${r.id}/quotes`)); return 'Quotes opened.'; })}>Open the quotes</button>}</p>}
                <ul style={list}>{quotes.quotes.map((q) => <li key={q.id} className="dim__note">{q.vendor_name}: {q.amount === null ? 'sealed' : money(q.amount, cur)}{q.lead_days !== null ? ` · ${q.lead_days} days` : ''}{q.notes ? ` · ${q.notes}` : ''}{r.selected_quote_id === q.id ? ' · CHOSEN' : ''}
                  {!quotes.sealed && r.selected_quote_id !== q.id && <> <button type="button" className="cs__btn" onClick={() => setF('chooseQuote', q.id)}>Choose</button></>}</li>)}</ul>
                {f('chooseQuote') && <form className="ig__form" onSubmit={(e) => { e.preventDefault(); void act(r.id, async () => { await postJson(`/api/procurement/requests/${r.id}/select`, { quoteId: f('chooseQuote'), reason: f('chooseReason') }); setForm({}); setQuotes(await get(`/api/procurement/requests/${r.id}/quotes`)); return 'Quote chosen.'; }); }}>
                  <Field id={`why-${r.id}`} label="Why this quote"><input id={`why-${r.id}`} className="cs__input" required value={f('chooseReason')} onChange={(e) => setF('chooseReason', e.target.value)} /></Field>
                  <button type="submit" className="cs__btn cs__btn--primary">Choose this quote</button>
                </form>}
                <form className="ig__form" onSubmit={(e) => { e.preventDefault(); void act(r.id, async () => { await postJson(`/api/procurement/requests/${r.id}/quotes`, { vendorId: f('qVendor'), amount: f('qAmount'), leadDays: f('qDays'), notes: f('qNotes') }); setForm({}); setQuotes(await get(`/api/procurement/requests/${r.id}/quotes`)); return 'Quote recorded.'; }); }}>
                  <div className="ig__formTitle"><strong>Record a quote</strong></div>
                  <Field id={`qv-${r.id}`} label="Supplier"><select id={`qv-${r.id}`} className="cs__input" required value={f('qVendor')} onChange={(e) => setF('qVendor', e.target.value)}><option value="">Choose…</option>{approvedVendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</select></Field>
                  <Field id={`qa-${r.id}`} label={`Amount (${cur})`}><input id={`qa-${r.id}`} className="cs__input" required inputMode="decimal" value={f('qAmount')} onChange={(e) => setF('qAmount', e.target.value)} /></Field>
                  <Field id={`qd-${r.id}`} label="Lead time (days)"><input id={`qd-${r.id}`} className="cs__input" inputMode="numeric" value={f('qDays')} onChange={(e) => setF('qDays', e.target.value)} /></Field>
                  <Field id={`qn-${r.id}`} label="Notes"><input id={`qn-${r.id}`} className="cs__input" value={f('qNotes')} onChange={(e) => setF('qNotes', e.target.value)} /></Field>
                  <button type="submit" className="cs__btn">Record quote</button>
                </form>
                {!quotes.opensAt && <form className="ig__form" onSubmit={(e) => { e.preventDefault(); void act(r.id, async () => { await postJson(`/api/procurement/requests/${r.id}/deadline`, { opensAt: new Date(f('opensAt')).toISOString() }); setQuotes(await get(`/api/procurement/requests/${r.id}/quotes`)); return 'Quotes are sealed until the deadline.'; }); }}>
                  <div className="ig__formTitle"><strong>Seal quotes until a deadline</strong><p>Optional. Amounts stay hidden from everyone until the deadline passes and someone opens them.</p></div>
                  <Field id={`op-${r.id}`} label="Open quotes after"><input id={`op-${r.id}`} type="datetime-local" className="cs__input" required value={f('opensAt')} onChange={(e) => setF('opensAt', e.target.value)} /></Field>
                  <button type="submit" className="cs__btn">Seal</button>
                </form>}
                <form className="ig__form" onSubmit={(e) => { e.preventDefault(); void act(r.id, async () => { const o = await postJson<{ number: number; status: string }>('/api/procurement/orders', { requisitionId: r.id, vendorId: f('oVendor'), expectedBy: f('oBy'), deliveryLocation: f('oWhere'), exceptionReason: f('oException'), lines: lineBody() }); setOpen(null); return o.status === 'pending_approval' ? `Order ${o.number} raised; it is over the request by more than the tolerance and needs approval.` : `Order ${o.number} issued.`; }); }}>
                  <div className="ig__formTitle"><strong>Raise the order</strong></div>
                  <Field id={`ov-${r.id}`} label="Supplier"><select id={`ov-${r.id}`} className="cs__input" required value={f('oVendor')} onChange={(e) => setF('oVendor', e.target.value)}><option value="">Choose…</option>{approvedVendors.map((v) => <option key={v.id} value={v.id}>{v.name}{v.status !== 'approved' ? ` (${v.status})` : ''}</option>)}</select></Field>
                  <Field id={`ob-${r.id}`} label="Expected by"><input id={`ob-${r.id}`} type="date" className="cs__input" value={f('oBy')} onChange={(e) => setF('oBy', e.target.value)} /></Field>
                  <Field id={`ow-${r.id}`} label="Deliver to"><input id={`ow-${r.id}`} className="cs__input" value={f('oWhere')} onChange={(e) => setF('oWhere', e.target.value)} /></Field>
                  <Field id={`oe-${r.id}`} label="Exception reason (restricted or suspended supplier)"><input id={`oe-${r.id}`} className="cs__input" value={f('oException')} onChange={(e) => setF('oException', e.target.value)} /></Field>
                  {lineEditor(`ol-${r.id}`)}
                  <button type="submit" className="cs__btn cs__btn--primary" disabled={busy === r.id}>Raise order</button>
                </form>
              </div>}
            </div>
            <div className="pp2__roleEdit">
              <button type="button" className="cs__btn" onClick={() => onOpenRecord(r.instance_id)}>Open request</button>
              <button type="button" className="cs__btn cs__btn--primary" aria-expanded={open === r.id} onClick={() => void toggleReq(r)}>{open === r.id ? 'Close' : 'Quotes and order'}</button>
            </div>
          </li>)}
          {reqs.data && !reqs.data.some((r) => r.status === 'approved' || r.status === 'sourcing') && <li className="ig__row"><div className="ig__rowMain"><p>No approved requests waiting to be ordered.</p></div></li>}
        </ul>}

        {tab === 'orders' && <ul style={list}>
          {(orders.data ?? []).map((o) => <li key={o.id} className="ig__row" style={{ flexWrap: 'wrap' }}>
            <div className="ig__rowMain">
              <strong>Order {o.number} · {o.vendor_name}</strong><span className={`ig__status ${['closed', 'received'].includes(o.status) ? '' : 'ig__status--off'}`}>{ORDER_WORDS[o.status] ?? words(o.status)}</span>
              <p>{money(o.total, o.currency)}{o.revision > 1 ? ` · revision ${o.revision}` : ''}{o.requisition_reference ? ` · for ${o.requisition_reference}` : ''}{o.agreement_title ? ` · under "${o.agreement_title}"` : ''}{o.expected_by ? ` · expected ${day(o.expected_by)}` : ''}{o.exception_reason ? ` · exception: ${o.exception_reason}` : ''}</p>
              {open === o.id && detail && <div className="ex__lines">
                <table className="ex__table"><thead><tr><th scope="col">Line</th><th scope="col">Ordered</th><th scope="col">Accepted</th><th scope="col">Rejected</th><th scope="col">Still to come</th><th scope="col">To invoice</th></tr></thead>
                  <tbody>{detail.lines.map((l) => <tr key={l.id}><td>{l.lineNo}. {l.description} @ {l.unitPrice}</td><td>{l.quantity}</td><td>{l.netAccepted}{l.returned ? ` (${l.returned} returned)` : ''}</td><td>{l.rejected}</td><td>{l.toCome}</td><td>{l.toInvoice}</td></tr>)}</tbody></table>
                {['issued', 'partially_received'].includes(detail.status) && <form className="ig__form" onSubmit={(e) => { e.preventDefault(); void act(o.id, async () => { const body = { evidenceRef: f('ev'), lines: detail.lines.filter((l) => qty[l.id] && (Number(qty[l.id]!.a) > 0 || Number(qty[l.id]!.r) > 0)).map((l) => ({ lineId: l.id, accepted: Number(qty[l.id]!.a || 0), rejected: Number(qty[l.id]!.r || 0), reason: qty[l.id]!.why })) }; const done = await postJson<{ status: string }>(`/api/procurement/orders/${o.id}/receive`, body); setOpen(null); return `Delivery recorded: ${ORDER_WORDS[done.status]}.`; }); }}>
                  <div className="ig__formTitle"><strong>Record a delivery</strong><p>Approving an order does not prove anything arrived. Count what came.</p></div>
                  {detail.lines.filter((l) => l.toCome > 0).map((l) => <div key={l.id} style={{ gridColumn: '1 / -1' }} className="pp2__roleEdit">
                    <span className="pp2__inlineLabel">{l.lineNo}. {l.description}</span>
                    <label className="pp2__inlineLabel" htmlFor={`ra-${l.id}`}>Accepted</label><input id={`ra-${l.id}`} className="cs__input pp2__date" inputMode="decimal" value={qty[l.id]?.a ?? ''} onChange={(e) => setQty({ ...qty, [l.id]: { ...(qty[l.id] ?? { a: '', r: '', why: '' }), a: e.target.value } })} />
                    <label className="pp2__inlineLabel" htmlFor={`rr-${l.id}`}>Rejected</label><input id={`rr-${l.id}`} className="cs__input pp2__date" inputMode="decimal" value={qty[l.id]?.r ?? ''} onChange={(e) => setQty({ ...qty, [l.id]: { ...(qty[l.id] ?? { a: '', r: '', why: '' }), r: e.target.value } })} />
                    <label className="pp2__inlineLabel" htmlFor={`rw-${l.id}`}>Why rejected</label><input id={`rw-${l.id}`} className="cs__input" value={qty[l.id]?.why ?? ''} onChange={(e) => setQty({ ...qty, [l.id]: { ...(qty[l.id] ?? { a: '', r: '', why: '' }), why: e.target.value } })} />
                  </div>)}
                  <Field id={`ev-${o.id}`} label="Delivery note or photo reference"><input id={`ev-${o.id}`} className="cs__input" value={f('ev')} onChange={(e) => setF('ev', e.target.value)} /></Field>
                  <button type="submit" className="cs__btn cs__btn--primary">Record delivery</button>
                </form>}
                {!['cancelled', 'closed', 'pending_approval'].includes(detail.status) && detail.lines.some((l) => l.toInvoice > 0) && <form className="ig__form" onSubmit={(e) => { e.preventDefault(); void act(o.id, async () => { const body = { orderId: o.id, invoiceNo: f('invNo'), invoiceDate: f('invDate'), lines: detail.lines.filter((l) => qty[`i-${l.id}`] && Number(qty[`i-${l.id}`]!.a) > 0).map((l) => ({ lineId: l.id, quantity: Number(qty[`i-${l.id}`]!.a), unitPrice: Number(qty[`i-${l.id}`]!.price ?? l.unitPrice) })) }; const done = await postJson<{ status: string; mismatches: string[] }>('/api/procurement/invoices', body); setOpen(null); return done.status === 'held' ? `Invoice held: ${done.mismatches.join('; ')}` : 'Invoice matched and approved to pay.'; }); }}>
                  <div className="ig__formTitle"><strong>Enter the supplier&rsquo;s invoice</strong><p>It is matched against what was accepted and the order price. A mismatch holds it with the reason.</p></div>
                  <Field id={`in-${o.id}`} label="Invoice number"><input id={`in-${o.id}`} className="cs__input" required value={f('invNo')} onChange={(e) => setF('invNo', e.target.value)} /></Field>
                  <Field id={`id-${o.id}`} label="Invoice date"><input id={`id-${o.id}`} type="date" className="cs__input" required value={f('invDate')} onChange={(e) => setF('invDate', e.target.value)} /></Field>
                  {detail.lines.map((l) => <div key={l.id} style={{ gridColumn: '1 / -1' }} className="pp2__roleEdit">
                    <span className="pp2__inlineLabel">{l.lineNo}. {l.description}</span>
                    <label className="pp2__inlineLabel" htmlFor={`iq-${l.id}`}>Quantity invoiced</label><input id={`iq-${l.id}`} className="cs__input pp2__date" inputMode="decimal" value={qty[`i-${l.id}`]?.a ?? ''} onChange={(e) => setQty({ ...qty, [`i-${l.id}`]: { ...(qty[`i-${l.id}`] ?? { a: '', r: '', why: '' }), a: e.target.value } })} />
                    <label className="pp2__inlineLabel" htmlFor={`ip-${l.id}`}>Unit price</label><input id={`ip-${l.id}`} className="cs__input pp2__date" inputMode="decimal" placeholder={String(l.unitPrice)} value={qty[`i-${l.id}`]?.price ?? ''} onChange={(e) => setQty({ ...qty, [`i-${l.id}`]: { ...(qty[`i-${l.id}`] ?? { a: '', r: '', why: '' }), price: e.target.value } })} />
                  </div>)}
                  <button type="submit" className="cs__btn cs__btn--primary">Enter invoice</button>
                </form>}
                {['issued', 'pending_approval', 'partially_received'].includes(detail.status) && <form className="ig__form" onSubmit={(e) => { e.preventDefault(); void act(o.id, async () => { const done = await postJson<{ status: string; revision: number }>(`/api/procurement/orders/${o.id}/revise`, { reason: f('revWhy'), lines: lineBody() }); setOpen(null); return done.status === 'pending_approval' ? `Revision ${done.revision} needs approval by someone else.` : `Revision ${done.revision} saved.`; }); }}>
                  <div className="ig__formTitle"><strong>Change the order</strong><p>A new revision. An increase past the tolerance goes back for approval.</p></div>
                  {lineEditor(`rv-${o.id}`)}
                  <Field id={`rw-${o.id}`} label="Why it is changing"><input id={`rw-${o.id}`} className="cs__input" required value={f('revWhy')} onChange={(e) => setF('revWhy', e.target.value)} /></Field>
                  <button type="submit" className="cs__btn">Save revision</button>
                </form>}
                {detail.revisions.length > 1 && <details className="pp2__history"><summary>Revisions ({detail.revisions.length})</summary><ul>{detail.revisions.map((r) => <li key={r.revision}>Revision {r.revision}: {money(r.total, cur)} · {r.reason} · {r.actor_name} · {day(r.occurred_at)}</li>)}</ul></details>}
              </div>}
            </div>
            <div className="pp2__roleEdit">
              <button type="button" className="cs__btn cs__btn--primary" aria-expanded={open === o.id} onClick={() => void toggleOrder(o)}>{open === o.id ? 'Close' : 'Open'}</button>
              {o.status === 'pending_approval' && canAdminister && <button type="button" className="cs__btn" onClick={() => void act(o.id, async () => { await postJson(`/api/procurement/orders/${o.id}/approve`, {}); return `Order ${o.number} approved and issued.`; })}>Approve</button>}
              {!['cancelled', 'closed'].includes(o.status) && <button type="button" className="cs__btn" onClick={() => { setAsking({ id: o.id, label: 'Why cancel this order?', run: async (reason) => { await postJson(`/api/procurement/orders/${o.id}/cancel`, { reason }); return `Order ${o.number} cancelled; the budget is released.`; } }); }}>Cancel</button>}
            </div>
          </li>)}
          {orders.data && !orders.data.length && <li className="ig__row"><div className="ig__rowMain"><p>No orders yet.</p></div></li>}
        </ul>}

        {tab === 'invoices' && <>
          <div className="ig__panelHead"><div><h3>Supplier invoices</h3><p>Held invoices show why. Someone other than whoever entered it decides; payment needs the supplier&rsquo;s bank details checked.</p></div>
            <button type="button" className="cs__btn" disabled={busy === 'export'} onClick={() => void act('export', async () => { const out = await postJson<{ invoices: number; total: number; filename: string; csv: string }>('/api/procurement/invoices/export', {}); const url = URL.createObjectURL(new Blob([out.csv], { type: 'text/csv;charset=utf-8' })); const a = document.createElement('a'); a.href = url; a.download = out.filename; a.click(); URL.revokeObjectURL(url); return `Exported ${out.invoices} paid invoices (${money(out.total, cur)}).`; })}>Export paid invoices</button></div>
          <ul style={list}>{(invoices.data ?? []).map((i) => <li key={i.id} className="ig__row" style={{ flexWrap: 'wrap' }}>
            <div className="ig__rowMain">
              <strong>{i.vendor_name} · {i.invoice_no}</strong><span className={`ig__status ${i.status === 'paid' || i.status === 'approved' ? '' : 'ig__status--off'}`}>{INVOICE_WORDS[i.status] ?? i.status}</span>
              <p>{money(i.total, i.currency)} · order {i.order_number} · dated {day(i.invoice_date)} · entered by {i.entered_by_name}{i.payment_ref ? ` · paid, ref ${i.payment_ref}` : ''}{i.review_reason ? ` · decision: ${i.review_reason}` : ''}</p>
              {i.mismatches.map((m) => <p key={m} className="ig__rowError">✕ {m}</p>)}
              {i.status === 'approved' && !i.bank_verified && <p className="ig__rowError">The supplier&rsquo;s bank details are not checked; payment is blocked.</p>}
            </div>
            <div className="pp2__roleEdit">
              {i.status === 'held' && canAdminister && <>
                <button type="button" className="cs__btn" onClick={() => { setAsking({ id: i.id, label: 'Why approve despite the mismatch?', run: async (reason) => { await postJson(`/api/procurement/invoices/${i.id}/review`, { decision: 'approve', reason }); return 'Approved with your reason recorded.'; } }); }}>Approve anyway</button>
                <button type="button" className="cs__btn" onClick={() => { setAsking({ id: i.id, label: 'Why reject this invoice?', run: async (reason) => { await postJson(`/api/procurement/invoices/${i.id}/review`, { decision: 'reject', reason }); return 'Invoice rejected.'; } }); }}>Reject</button>
              </>}
              {i.status === 'approved' && <button type="button" className="cs__btn cs__btn--primary" disabled={!i.bank_verified} onClick={() => { setAsking({ id: i.id, label: 'Payment reference', run: async (reference) => { await postJson(`/api/procurement/invoices/${i.id}/pay`, { reference }); return 'Payment recorded.'; } }); }}>Record payment</button>}
            </div>
          </li>)}
            {invoices.data && !invoices.data.length && <li className="ig__row"><div className="ig__rowMain"><p>No invoices yet. Enter one from its order.</p></div></li>}
          </ul>
        </>}

        {tab === 'suppliers' && <>
          <form className="ig__form" onSubmit={(e) => { e.preventDefault(); void act('vendor', async () => { await postJson('/api/procurement/vendors', { ...vendorForm, categories: (vendorForm.categories ?? '').split(',').map((c) => c.trim()).filter(Boolean) }); setVendorForm({}); return 'Supplier added as a draft. Send it for review, then an admin approves it.'; }); }}>
            <div className="ig__formTitle"><strong>Add a supplier</strong></div>
            {([['name', 'Name'], ['registrationNo', 'Registration number'], ['taxId', 'Tax ID'], ['contactName', 'Contact name'], ['contactEmail', 'Contact email'], ['contactPhone', 'Contact phone'], ['categories', 'Categories (comma separated)'], ['documentsRef', 'Where their documents are']] as const).map(([k, label]) => <Field key={k} id={`vf-${k}`} label={label}><input id={`vf-${k}`} className="cs__input" required={k === 'name'} value={vendorForm[k] ?? ''} onChange={(e) => setVendorForm({ ...vendorForm, [k]: e.target.value })} /></Field>)}
            <button type="submit" className="cs__btn cs__btn--primary" disabled={busy === 'vendor'}>Add supplier</button>
          </form>
          <ul style={list}>{(vendors.data ?? []).map((v) => {
            const onTime = v.delivered_with_date ? Math.round((v.on_time / v.delivered_with_date) * 100) : null;
            const rejectedPct = Number(v.delivered_qty) ? Math.round((Number(v.rejected_qty) / Number(v.delivered_qty)) * 100) : null;
            return <li key={v.id} className="ig__row" style={{ flexWrap: 'wrap' }}>
              <div className="ig__rowMain">
                <strong>{v.name}</strong><span className={`ig__status ${v.status === 'approved' ? '' : 'ig__status--off'}`}>{words(v.status)}</span>
                <p>{[v.tax_id && `Tax ID ${v.tax_id}`, v.contact_name, v.contact_email, (v.categories ?? []).join(', ')].filter(Boolean).join(' · ')}</p>
                {v.status_reason && <p className="ig__rowError">{v.status_reason}</p>}
                <p>{v.orders} orders{onTime !== null ? ` · ${onTime}% on time` : ''}{rejectedPct !== null ? ` · ${rejectedPct}% of delivered quantity rejected` : ''}{v.invoices_held ? ` · ${v.invoices_held} invoices held` : ''}</p>
                <p className={v.bank_verified ? '' : 'ig__rowError'}>{v.bank_last4 ? `Bank: ${v.bank_name} •••• ${v.bank_last4} — ${v.bank_verified ? 'checked' : 'not checked'}` : 'No bank details yet'}{revealed[v.id] ? ` · full number ${revealed[v.id]}` : ''}</p>
                {open === v.id && <form className="ig__form" onSubmit={(e) => { e.preventDefault(); void act(v.id, async () => { await postJson(`/api/procurement/vendors/${v.id}/bank`, { accountName: f('bName'), bankName: f('bBank'), bankCode: f('bCode'), accountNumber: f('bNo') }); setForm({}); setOpen(null); return 'Bank details saved. Someone else must check them before any payment.'; }); }}>
                  <div className="ig__formTitle"><strong>Bank details</strong><p>Someone other than you must check them before payment.</p></div>
                  <Field id={`bn-${v.id}`} label="Account name"><input id={`bn-${v.id}`} className="cs__input" required value={f('bName')} onChange={(e) => setF('bName', e.target.value)} /></Field>
                  <Field id={`bb-${v.id}`} label="Bank"><input id={`bb-${v.id}`} className="cs__input" required value={f('bBank')} onChange={(e) => setF('bBank', e.target.value)} /></Field>
                  <Field id={`bc-${v.id}`} label="Bank or sort code"><input id={`bc-${v.id}`} className="cs__input" value={f('bCode')} onChange={(e) => setF('bCode', e.target.value)} /></Field>
                  <Field id={`bx-${v.id}`} label="Account number"><input id={`bx-${v.id}`} className="cs__input" required autoComplete="off" value={f('bNo')} onChange={(e) => setF('bNo', e.target.value)} /></Field>
                  <button type="submit" className="cs__btn cs__btn--primary">Save bank details</button>
                </form>}
              </div>
              <div className="pp2__roleEdit">
                {v.status === 'draft' && <button type="button" className="cs__btn" onClick={() => void act(v.id, async () => { await postJson(`/api/procurement/vendors/${v.id}/status`, { to: 'under_review' }); return `${v.name} sent for review.`; })}>Send for review</button>}
                {['under_review', 'restricted', 'suspended'].includes(v.status) && canAdminister && <button type="button" className="cs__btn cs__btn--primary" onClick={() => void act(v.id, async () => { await postJson(`/api/procurement/vendors/${v.id}/status`, { to: 'approved' }); return `${v.name} approved.`; })}>Approve</button>}
                {['approved', 'restricted'].includes(v.status) && <button type="button" className="cs__btn" onClick={() => { setAsking({ id: v.id, label: `Why suspend ${v.name}?`, run: async (reason) => { await postJson(`/api/procurement/vendors/${v.id}/status`, { to: 'suspended', reason }); return `${v.name} suspended.`; } }); }}>Suspend</button>}
                <button type="button" className="cs__btn" aria-expanded={open === v.id} onClick={() => { setForm({}); setOpen(open === v.id ? null : v.id); }}>{v.bank_last4 ? 'Change bank details' : 'Add bank details'}</button>
                {v.bank_last4 && !v.bank_verified && <button type="button" className="cs__btn" onClick={() => void act(v.id, async () => { await postJson(`/api/procurement/vendors/${v.id}/bank/verify`, {}); return 'Bank details checked.'; })}>Mark bank details checked</button>}
                {v.bank_last4 && !revealed[v.id] && <button type="button" className="cs__btn" onClick={() => void act(v.id, async () => { const b = await postJson<{ accountNumber: string }>(`/api/procurement/vendors/${v.id}/bank/reveal`, {}); setRevealed({ ...revealed, [v.id]: b.accountNumber }); return 'Shown. Viewing is recorded.'; })}>Show full number</button>}
              </div>
            </li>;
          })}</ul>
        </>}

        {tab === 'agreements' && <>
          {canAdminister && <form className="ig__form" onSubmit={(e) => { e.preventDefault(); void act('agreement', async () => { await postJson('/api/procurement/agreements', { vendorId: f('gVendor'), title: f('gTitle'), limitAmount: f('gLimit'), validFrom: f('gFrom'), validTo: f('gTo') }); setForm({}); return 'Agreement saved.'; }); }}>
            <div className="ig__formTitle"><strong>Add a framework agreement</strong><p>Orders under it use up its limit; nothing can go over.</p></div>
            <Field id="g-vendor" label="Supplier"><select id="g-vendor" className="cs__input" required value={f('gVendor')} onChange={(e) => setF('gVendor', e.target.value)}><option value="">Choose…</option>{(vendors.data ?? []).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</select></Field>
            <Field id="g-title" label="Title"><input id="g-title" className="cs__input" required value={f('gTitle')} onChange={(e) => setF('gTitle', e.target.value)} /></Field>
            <Field id="g-limit" label={`Limit (${cur})`}><input id="g-limit" className="cs__input" required inputMode="decimal" value={f('gLimit')} onChange={(e) => setF('gLimit', e.target.value)} /></Field>
            <Field id="g-from" label="From"><input id="g-from" type="date" className="cs__input" required value={f('gFrom')} onChange={(e) => setF('gFrom', e.target.value)} /></Field>
            <Field id="g-to" label="To"><input id="g-to" type="date" className="cs__input" required value={f('gTo')} onChange={(e) => setF('gTo', e.target.value)} /></Field>
            <button type="submit" className="cs__btn cs__btn--primary">Save agreement</button>
          </form>}
          <ul style={list}>{(agreements.data ?? []).map((g) => <li key={g.id} className="ig__row"><div className="ig__rowMain"><strong>{g.title}</strong><span className="ig__status">{g.vendor_name}</span><p>{day(g.valid_from)} to {day(g.valid_to)} · {money(g.limit_amount, cur)} limit · {money(g.used, cur)} used · <strong>{money(g.remaining, cur)} left</strong></p></div></li>)}</ul>
        </>}

        {tab === 'budgets' && <ul style={list}>
          {(budgets.data ?? []).map((b) => <li key={b.id} className="ig__row"><div className="ig__rowMain"><strong>{b.cost_centre}</strong><span className="ig__status">{b.mode === 'enforced' ? 'Enforced' : 'Advisory'}</span><p>{day(b.period_start)} to {day(b.period_end)} · {money(b.amount, cur)} · {money(b.consumed, cur)} committed · {money(b.reserved, cur)} in requests · <strong>{money(b.available, cur)} left</strong></p></div></li>)}
          <li className="ig__row"><div className="ig__rowMain"><p>Budgets are shared with Expenses: one budget per cost centre covers both claims and purchases. Owners and admins set them on the Expenses page, or here once the shared budget screen arrives.</p></div></li>
        </ul>}

        {tab === 'rules' && ruleDraft && <form className="ig__form" onSubmit={(e) => { e.preventDefault(); void act('rules', async () => { await postJson('/api/procurement/settings', ruleDraft); await rules.reload(); return 'Rules saved.'; }); }}>
          <div className="ig__formTitle"><strong>Procurement rules</strong><p>Amounts in {cur}. New requests use these from now on.</p></div>
          {([['managerLimit', 'A manager alone approves requests up to'], ['priceTolerancePct', 'Invoice price may be above the order price by (%)'], ['amountTolerance', 'Invoice total may be above the order by'], ['orderIncreasePct', 'An order may exceed its request by (%) before re-approval'], ['quotesRequired', 'Quotes needed'], ['quotesRequiredOver', 'for requests over']] as const).map(([k, label]) => <Field key={k} id={`rl-${k}`} label={label}><input id={`rl-${k}`} className="cs__input" inputMode="decimal" disabled={!canAdminister} value={String(ruleDraft[k])} onChange={(e) => setRuleDraft({ ...ruleDraft, [k]: Number(e.target.value) })} /></Field>)}
          <div><label className="pp2__inlineLabel"><input type="checkbox" disabled={!canAdminister} checked={ruleDraft.requireVendorBankCheck} onChange={(e) => setRuleDraft({ ...ruleDraft, requireVendorBankCheck: e.target.checked })} /> Supplier bank details must be checked before paying</label></div>
          {canAdminister ? <button type="submit" className="cs__btn cs__btn--primary" disabled={busy === 'rules'}>Save rules</button> : <p className="ig__rowMain">Only owners and admins can change the rules.</p>}
        </form>}
      </section>
    </div>
  </div>;
}
