// Invoices — cut GST tax invoices from dispatched challan lines.
// Pick a customer, tick the uninvoiced lines, the GST engine does the rest.
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmt } from '../api.js';
import { Button, Checkbox, DataTable, dueDelta, Field, Input, KpiCard, KpiFilterNotice, KpiRow, Modal, PageHeader, searchText, Select, StatusBadge, Tabs, useKpiFilter, useToast } from '../components/ui.jsx';
import { threadColumn, unreadRowClass } from '../components/ThreadCell.jsx';
import ProductIdentity from '../components/ProductIdentity.jsx';
import { Plus, FileText, Wallet, AlertTriangle, Trash2, Banknote, CalendarDays, Clock } from 'lucide-react';

// One batched call paints the thread column for a whole list. /threads/summary
// refuses more than 200 ids at once — a truncated answer is indistinguishable
// from "nobody has commented here" — so a long list is asked for in slices.
const THREAD_CHUNK = 200;
const threadSummary = (entity, ids) => {
  const calls = [];
  for (let i = 0; i < ids.length; i += THREAD_CHUNK) {
    calls.push(api.get(`/threads/summary?entity=${entity}&ids=${ids.slice(i, i + THREAD_CHUNK).join(',')}`));
  }
  return Promise.all(calls).then(parts => Object.assign({}, ...parts));
};

// Rows behind the clickable billing cards. The strip is book-level while the
// tabs split open vs settled, so a card can select rows the ACTIVE TAB does not
// hold — clicking "Outstanding" from the Settled tab would filter an already
// disjoint list to nothing. Each card therefore also names the tab it belongs
// to, and clicking it switches there first.
const BILLING_KPI_ROWS = {
  unpaid: i => (+i.paid || 0) < (+i.total || 0) && i.status !== 'cancelled',
  collected: i => (+i.paid || 0) > 0 && i.status !== 'cancelled',
  mtd: i => {
    const d = i.invoice_date ? new Date(i.invoice_date) : null;
    if (!d || Number.isNaN(+d)) return false;
    const n = new Date();
    return d.getMonth() === n.getMonth() && d.getFullYear() === n.getFullYear();
  },
};
const BILLING_KPI_LABEL = {
  unpaid: 'invoices with a balance outstanding',
  collected: 'invoices with a payment received',
  mtd: 'invoices raised this month',
};
// Which tab actually contains each card's rows.
const BILLING_KPI_TAB = { unpaid: 'open', collected: null, mtd: null };

export default function Invoices({ embedded = false }) {
  const toast = useToast();
  const [invoices, setInvoices] = useState([]);
  const [uninvoiced, setUninvoiced] = useState([]);
  const [creating, setCreating] = useState(false);
  const [customerId, setCustomerId] = useState('');
  const [picked, setPicked] = useState({});
  const [tab, setTab] = useState('open');
  const [rec, setRec] = useState(null); // record-payment form
  const [completePrompt, setCompletePrompt] = useState(null); // { items, picked } after invoicing
  const [clashPrompt, setClashPrompt] = useState(null); // same-vehicle strength mix-up alarm

  const [threads, setThreads] = useState({});

  const load = () => {
    api.get('/invoices').then(is => {
      setInvoices(is);
      threadSummary('invoice', is.map(i => i.id)).then(setThreads).catch(() => {});
    });
    api.get('/billing/uninvoiced').then(setUninvoiced);
  };
  useEffect(() => { load(); }, []);

  const openInvoices = invoices.filter(i => i.status === 'open');
  const settledInvoices = invoices.filter(i => i.status !== 'open');
  // Scoped to the tab, so switching tabs drops a selection that was chosen
  // against the other list.
  const billingKpi = useKpiFilter(tab);
  const tabInvoices = tab === 'open' ? openInvoices : settledInvoices;
  const invoiceRows = billingKpi.apply(tabInvoices, BILLING_KPI_ROWS);

  const customers = useMemo(() => {
    const seen = {};
    for (const l of uninvoiced) seen[l.customer_id] = l.customer_name;
    return Object.entries(seen).map(([id, name]) => ({ id: +id, name }));
  }, [uninvoiced]);

  const lines = useMemo(
    () => uninvoiced.filter(l => l.customer_id === +customerId),
    [uninvoiced, customerId]);

  const selected = lines.filter(l => picked[l.dispatch_line_id]);
  // Shade-card expiry engine — selected lines whose product's shade card has
  // crossed its 1-year lifespan fire a critical alert before billing.
  const staleShades = [...new Map(selected.filter(l => l.shade_expired)
    .map(l => [l.product_id, l])).values()];
  const subtotal = selected.reduce((s, l) => s + l.amount, 0);
  const intra = selected[0] && (selected[0].state || '').trim().toLowerCase() === 'punjab';
  // per-line GST — each carton carries its own rate (5% / 12% / 18%)
  const tax = selected.reduce((s, l) => s + l.amount * (l.gst_pct ?? 12) / 100, 0);
  const grand = Math.round(subtotal + tax);
  const rates = [...new Set(selected.map(l => l.gst_pct ?? 12))].sort((a, b) => a - b);

  // Record-payment helpers — receivables workflow lives here, next to the invoices.
  const payCustomers = useMemo(() => {
    const seen = {};
    for (const i of invoices) seen[i.customer_id] = i.customer_name;
    return Object.entries(seen).map(([id, name]) => ({ id: +id, name }));
  }, [invoices]);
  const payableInvoices = useMemo(
    () => invoices.filter(i => i.status === 'open' && i.customer_id === +(rec?.customer_id || 0)),
    [invoices, rec?.customer_id]);
  const pickedInvoice = payableInvoices.find(i => i.id === +(rec?.invoice_id || 0));

  const savePayment = async () => {
    await api.post('/payments', {
      ...rec, customer_id: +rec.customer_id,
      invoice_id: rec.invoice_id ? +rec.invoice_id : null, amount: +rec.amount,
    });
    toast.success('Payment recorded');
    setRec(null); load();
  };

  const create = async (confirm = false) => {
    let inv;
    try {
      inv = await api.post('/invoices', {
        customer_id: +customerId,
        dispatch_line_ids: selected.map(l => l.dispatch_line_id),
        confirm_collision: confirm || undefined,
      });
    } catch (e) {
      // Soft same-vehicle strength alarm — ask, then re-submit with confirm.
      if (e.data?.code === 'PRODUCT_STRENGTH_COLLISION') { setClashPrompt(e.data.collision); return; }
      // HTTP errors already toast centrally (api.js). A client-side or network
      // error has no response (a serialization bug, or the backend unreachable) and
      // does NOT toast — surface it here so the button can never silently do nothing.
      if (!e.data) toast.error(e.message || 'Could not create the invoice');
      return;
    }
    toast.success(`Invoice ${inv.invoice_number} created — ₹${fmt.num(inv.total)}`);
    setClashPrompt(null); setCreating(false); setPicked({}); setCustomerId('');
    load();
    // These invoiced items are fully fulfilled but not yet marked complete —
    // offer to push them into the order's Completed roll-up right now.
    if (inv.completable?.length) {
      setCompletePrompt({ items: inv.completable, picked: Object.fromEntries(inv.completable.map(l => [l.order_line_id, true])) });
    }
  };

  // Delete an invoice — voids the bill and returns its dispatched line(s) to
  // un-invoiced. Blocked (server + here) once any payment is recorded.
  const del = async (inv) => {
    if (inv.paid > 0) { toast.error('Reverse the payment before deleting this invoice'); return; }
    if (!window.confirm(
      `Delete invoice ${inv.invoice_number} (${fmt.inr(inv.total)})?\n\n` +
      `This voids the bill and returns its dispatched line(s) to un-invoiced so they can be re-billed. This cannot be undone.`)) return;
    try {
      await api.del(`/invoices/${inv.id}`);
      toast.success(`${inv.invoice_number} deleted`);
      load();
    } catch (e) {
      // HTTP errors (e.g. payments recorded) toast centrally; surface a network error too.
      if (!e.data) toast.error(e.message || 'Could not delete the invoice');
    }
  };

  const confirmComplete = async () => {
    const chosen = completePrompt.items.filter(l => completePrompt.picked[l.order_line_id]);
    if (!chosen.length) { setCompletePrompt(null); return; }
    const byOrder = {};
    for (const l of chosen) (byOrder[l.order_id] ||= []).push(l.order_line_id);
    let orderDone = 0;
    for (const [orderId, lineIds] of Object.entries(byOrder)) {
      const r = await api.post(`/orders/${orderId}/complete-lines`, { line_ids: lineIds });
      if (r.order_completed) orderDone += 1;
    }
    toast.success(`${chosen.length} item${chosen.length > 1 ? 's' : ''} marked complete${orderDone ? ` · ${orderDone} order${orderDone > 1 ? 's' : ''} moved to Completed` : ''}`);
    setCompletePrompt(null); load();
  };

  // Receivables KPIs are read across the whole book, not the open tab — a
  // "collected" figure scoped to unpaid invoices is zero by definition, and an
  // outstanding figure scoped to settled ones is zero too. Cancelled invoices
  // are excluded everywhere: they were never a receivable.
  const kpiBilling = (() => {
    const live = invoices.filter(i => i.status !== 'cancelled');
    const billed = live.reduce((s, i) => s + (+i.total || 0), 0);
    const paid = live.reduce((s, i) => s + (+i.paid || 0), 0);
    const unpaid = live.filter(i => (+i.paid || 0) < (+i.total || 0));
    const oldest = unpaid.reduce((best, i) =>
      (dueDelta(i.invoice_date) ?? -1) > (dueDelta(best?.invoice_date) ?? -1) ? i : best, null);
    const now = new Date();
    const mtd = live.filter(i => {
      const t = i.invoice_date ? new Date(i.invoice_date) : null;
      return !!t && !Number.isNaN(+t) && t.getMonth() === now.getMonth() && t.getFullYear() === now.getFullYear();
    });
    return {
      count: live.length,
      lines: live.reduce((s, i) => s + (+i.line_count || 0), 0),
      billed, paid,
      outstanding: Math.max(0, billed - paid),
      pct: billed > 0 ? Math.round((paid / billed) * 100) : 0,
      unpaidCount: unpaid.length,
      oldest,
      oldestDays: oldest ? (dueDelta(oldest.invoice_date) ?? 0) : 0,
      mtdCount: mtd.length,
      mtdValue: mtd.reduce((s, i) => s + (+i.total || 0), 0),
      unbilledLines: uninvoiced.length,
      unbilledValue: uninvoiced.reduce((s, l) => s + (+l.amount || 0), 0),
    };
  })();

  const actions = (
    <>
      <Button variant="secondary" onClick={() => setRec({ customer_id: '', invoice_id: '', amount: '', mode: 'neft', reference: '' })}
        disabled={!invoices.length}><Wallet size={15} /> Record Payment</Button>
      <Button onClick={() => setCreating(true)} disabled={uninvoiced.length === 0}>
        <Plus size={15} /> New Invoice{uninvoiced.length > 0 && <span className="ml-1 rounded-full bg-white/25 px-1.5 text-xs">{uninvoiced.length} lines waiting</span>}
      </Button>
    </>
  );

  return (
    <div>
      {!embedded && <PageHeader title="Invoices" subtitle="GST tax invoices from dispatched challans — place of supply decides CGST/SGST vs IGST" actions={actions} />}

      <KpiRow cols={6}>
        <KpiCard compact icon={FileText} tone="info" label="Invoiced"
          value={fmt.inrShort(kpiBilling.billed)} title={fmt.inr(kpiBilling.billed)}
          sub={`${fmt.count(kpiBilling.count, 'invoice')} · ${fmt.count(kpiBilling.lines, 'line')}`} />
        <KpiCard compact icon={Wallet} tone="good" label="Collected"
          value={fmt.inrShort(kpiBilling.paid)} title={fmt.inr(kpiBilling.paid)}
          sub={kpiBilling.billed ? `${kpiBilling.pct}% of everything billed` : 'nothing billed yet'}
          onClick={() => billingKpi.toggle('collected')} active={billingKpi.is('collected')} />
        {/* The Outstanding TAB already is the unpaid list, so this card selects
            that tab instead of adding a second filter that could disagree with
            it. Same reasoning as Planning's Board Short driving its chip. */}
        <KpiCard compact icon={Banknote} label="Outstanding"
          tone={kpiBilling.outstanding ? 'bad' : 'good'}
          value={fmt.inrShort(kpiBilling.outstanding)} title={fmt.inr(kpiBilling.outstanding)}
          sub={kpiBilling.unpaidCount ? `${fmt.count(kpiBilling.unpaidCount, 'invoice')} unpaid`
            : kpiBilling.count ? 'every invoice settled' : 'nothing billed yet'}
          onClick={() => setTab('open')} active={tab === 'open'} />
        <KpiCard compact icon={Clock} label="Oldest Unpaid"
          tone={kpiBilling.oldestDays >= 60 ? 'bad' : kpiBilling.oldestDays >= 30 ? 'warn' : kpiBilling.oldest ? 'neutral' : 'good'}
          value={kpiBilling.oldest ? `${kpiBilling.oldestDays}d` : '—'}
          sub={kpiBilling.oldest ? `${kpiBilling.oldest.invoice_number} · ${kpiBilling.oldest.customer_name}` : 'nothing pending'} />
        {/* These items are dispatch LINES — this table lists invoices and can
            never show them. The New Invoice picker is the screen that does, so
            the card opens it rather than filtering to nothing. */}
        <KpiCard compact icon={AlertTriangle} label="Awaiting Invoice"
          tone={kpiBilling.unbilledLines ? 'warn' : 'good'}
          value={fmt.inrShort(kpiBilling.unbilledValue)} title={fmt.inr(kpiBilling.unbilledValue)}
          sub={kpiBilling.unbilledLines ? `${fmt.count(kpiBilling.unbilledLines, 'dispatched line')} to bill` : 'nothing waiting to be billed'}
          onClick={uninvoiced.length ? () => setCreating(true) : undefined} />
        <KpiCard compact icon={CalendarDays} tone="neutral" label="Billed This Month"
          value={fmt.inrShort(kpiBilling.mtdValue)} title={fmt.inr(kpiBilling.mtdValue)}
          sub={`${fmt.count(kpiBilling.mtdCount, 'invoice')} raised`}
          onClick={() => billingKpi.toggle('mtd')} active={billingKpi.is('mtd')} />
      </KpiRow>
      <KpiFilterNotice filter={billingKpi} label={BILLING_KPI_LABEL[billingKpi.key]}
        shown={invoiceRows.length} total={tabInvoices.length} />

      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <Tabs active={tab} onChange={setTab} tabs={[
          { key: 'open', label: 'Outstanding', count: openInvoices.length },
          { key: 'settled', label: 'Settled', count: settledInvoices.length },
        ]} />
        {embedded && <div className="flex gap-2">{actions}</div>}
      </div>

      <DataTable searchable rows={invoiceRows}
        rowClass={unreadRowClass(threads, i => i.id)}
        getRowId={i => i.id}
        empty={tab === 'open' ? 'No outstanding invoices — dispatch first, then bill' : 'No settled invoices yet'}
        columns={[
          { key: 'invoice_number', label: 'Invoice', render: i => (
            <Link to={`/invoices/${i.id}`} onClick={e => e.stopPropagation()} className="font-bold text-brand-600 hover:underline">{i.invoice_number}</Link>) },
          { key: 'invoice_date', label: 'Date', render: i => fmt.date(i.invoice_date) },
          { key: 'customer_name', label: 'Customer', render: i => (<div><div className="font-semibold">{i.customer_name}</div><div className="text-xs text-gray-400">{i.state}</div></div>) },
          { key: 'subtotal', label: 'Taxable', align: 'right', render: i => fmt.inr(i.subtotal) },
          { key: 'tax', label: 'GST', align: 'right', render: i => <span className="text-xs text-gray-500">{i.igst > 0 ? `IGST ${fmt.inr(i.igst)}` : `C+S ${fmt.inr(i.cgst + i.sgst)}`}</span> },
          { key: 'total', label: 'Total', align: 'right', render: i => <span className="font-bold tabular-nums">{fmt.inr(i.total)}</span> },
          { key: 'paid', label: 'Paid', align: 'right', render: i => <span className={`tabular-nums ${i.paid >= i.total ? 'text-emerald-600 font-semibold' : 'text-gray-500'}`}>{fmt.inr(i.paid)}</span> },
          { key: 'status', label: 'Status', render: i => <StatusBadge status={i.status === 'open' && i.paid > 0 ? 'partially_received' : i.status} /> },
          threadColumn({ entity: 'invoice', threads, idOf: i => i.id }),
          { key: '_view', label: '', render: i => (
            <div className="flex items-center justify-end gap-3">
              <Link to={`/invoices/${i.id}`} onClick={e => e.stopPropagation()}
                className="inline-flex items-center gap-1 text-xs font-semibold text-gray-400 hover:text-brand-600"><FileText size={13} /> View</Link>
              <button type="button" disabled={i.paid > 0}
                title={i.paid > 0 ? 'Reverse the payment before deleting' : 'Delete this invoice'}
                onClick={e => { e.stopPropagation(); del(i); }}
                className="inline-flex items-center gap-1 text-xs font-semibold text-gray-400 transition hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-30">
                <Trash2 size={13} /> Delete</button>
            </div>) },
        ]}
        exportName={tab === 'open' ? 'Outstanding Invoices' : 'Settled Invoices'}
        exportSubtitle="GST tax invoices · CGST/SGST vs IGST by place of supply"
        exportSummary={rows => [
          { label: 'Invoices', value: rows.length },
          { label: 'Taxable', value: fmt.inr(rows.reduce((s, i) => s + (+i.subtotal || 0), 0)) },
          { label: 'GST', value: fmt.inr(rows.reduce((s, i) => s + (+i.igst || 0) + (+i.cgst || 0) + (+i.sgst || 0), 0)) },
          { label: 'Total', value: fmt.inr(rows.reduce((s, i) => s + (+i.total || 0), 0)) },
          { label: 'Paid', value: fmt.inr(rows.reduce((s, i) => s + (+i.paid || 0), 0)) },
        ]} />

      <Modal wide open={creating} onClose={() => setCreating(false)} title="New Tax Invoice"
        footer={<>
          <Button variant="secondary" onClick={() => setCreating(false)}>Cancel</Button>
          <Button onClick={() => create()} disabled={!selected.length}>
            Create Invoice{selected.length > 0 && ` — ${fmt.inr(grand)}`}
          </Button>
        </>}>
        <div className="space-y-4">
          <section className="ci-form-panel">
            <div className="ci-form-panel-title">
              <span>Billing customer</span>
              <span>{uninvoiced.length} dispatch lines waiting</span>
            </div>
            <Field label="Customer" required>
              <Select value={customerId} onChange={e => { setCustomerId(e.target.value); setPicked({}); }}>
                <option value="">Select customer with uninvoiced dispatches…</option>
                {customers.map(c => <option key={c.id} value={c.id} data-search={searchText(c)}>{c.name}</option>)}
              </Select>
            </Field>
          </section>

          {customerId && (
            <section className="ci-data-panel">
              <div className="ci-form-panel-title m-0 border-b border-slate-100 px-4 py-3">
                <span>Dispatch lines</span>
                <span>{selected.length} selected</span>
              </div>
              <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="ci-table-head">
                  <th className="px-3 py-2 w-8">
                    <input type="checkbox" className="h-4 w-4 rounded border-gray-300 text-brand-500"
                      checked={selected.length === lines.length && lines.length > 0}
                      onChange={e => setPicked(e.target.checked ? Object.fromEntries(lines.map(l => [l.dispatch_line_id, true])) : {})} />
                  </th>
                  <th className="px-3 py-2">Challan</th><th className="px-3 py-2">Product</th>
                  <th className="px-3 py-2 text-right">Qty</th><th className="px-3 py-2 text-right">Rate</th>
                  <th className="px-3 py-2 text-right">GST</th>
                  <th className="px-3 py-2 text-right">Amount</th>
                </tr></thead>
                <tbody>
                  {lines.map(l => (
                    <tr key={l.dispatch_line_id} className="ci-table-row cursor-pointer"
                      onClick={() => setPicked(p => ({ ...p, [l.dispatch_line_id]: !p[l.dispatch_line_id] }))}>
                      <td className="px-3 py-2">
                        <input type="checkbox" readOnly checked={!!picked[l.dispatch_line_id]} className="h-4 w-4 rounded border-gray-300 text-brand-500" />
                      </td>
                      <td className="px-3 py-2 text-xs font-semibold text-slate-600">{l.challan_number}<div className="font-normal text-slate-400">{fmt.date(l.dispatched_at)}</div></td>
                      <td className="px-3 py-2">
                        <div className="flex items-start gap-1.5">
                          <ProductIdentity row={l} compact className="min-w-0 flex-1" />
                          {l.shade_expired && (
                            <span title={`Shade card ${l.shade_card_code || ''} is ${fmt.num(l.shade_age_days)} days old — past its 1-year lifespan`}
                              className="inline-flex items-center gap-1 rounded-full bg-red-100 px-1.5 py-px text-[9px] font-bold uppercase tracking-wide text-red-700">
                              <AlertTriangle size={9} /> Shade expired
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-slate-400">PO {l.po_number}</div>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmt.num(l.qty)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">₹{l.rate}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-500">{l.gst_pct ?? 12}%</td>
                      <td className="px-3 py-2 text-right font-semibold tabular-nums">{fmt.inr(l.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            </section>
          )}

          {staleShades.length > 0 && (
            <div className="flex items-start gap-2 rounded-2xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs font-bold text-red-700">
              <AlertTriangle size={15} className="mt-0.5 shrink-0" />
              <span>
                Critical Alert: the Shade Card for {staleShades.length > 1 ? 'these products has' : 'this product has'} exceeded
                its 1-year lifespan and reached obsolescence — renewal / verification required before billing:
                {' '}{staleShades.map(l => `${l.product_name} (Age: ${fmt.num(l.shade_age_days)} days)`).join(' · ')}
              </span>
            </div>
          )}
          {selected.length > 0 && (
            <div className="ci-summary-panel">
              <div className="flex justify-between text-slate-600"><span>Taxable value</span><b className="tabular-nums">{fmt.inr(subtotal)}</b></div>
              <div className="flex justify-between text-slate-600">
                <span>{intra ? 'CGST + SGST (Punjab — intra-state)' : 'IGST (inter-state)'} @ {rates.join('% / ')}%</span>
                <b className="tabular-nums">{fmt.inr(tax)}</b>
              </div>
              <div className="mt-1 flex justify-between border-t border-slate-200 pt-1 text-slate-900"><span className="font-bold">Invoice total (rounded)</span><b className="tabular-nums">{fmt.inr(grand)}</b></div>
            </div>
          )}
        </div>
      </Modal>

      <Modal open={!!rec} onClose={() => setRec(null)} title="Record Payment"
        footer={<>
          <Button variant="secondary" onClick={() => setRec(null)}>Cancel</Button>
          <Button onClick={savePayment} disabled={!rec?.customer_id || !rec?.amount || +rec.amount <= 0}>Save Receipt</Button>
        </>}>
        {rec && (
          <div className="space-y-3">
            <Field label="Customer" required>
              <Select value={rec.customer_id} onChange={e => setRec({ ...rec, customer_id: e.target.value, invoice_id: '' })}>
                <option value="">Select…</option>
                {payCustomers.map(c => <option key={c.id} value={c.id} data-search={searchText(c)}>{c.name}</option>)}
              </Select>
            </Field>
            <Field label="Against Invoice" hint="Leave blank to record on account">
              <Select value={rec.invoice_id} onChange={e => {
                const inv = payableInvoices.find(i => i.id === +e.target.value);
                setRec({ ...rec, invoice_id: e.target.value, amount: inv ? String(+(inv.total - inv.paid).toFixed(2)) : rec.amount });
              }}>
                <option value="">On account</option>
                {payableInvoices.map(i => <option key={i.id} value={i.id} data-search={searchText(i)}>{i.invoice_number} — {fmt.inr(i.total - i.paid)} due</option>)}
              </Select>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Amount (₹)" required>
                <Input type="number" min="0" value={rec.amount} onChange={e => setRec({ ...rec, amount: e.target.value })} />
              </Field>
              <Field label="Mode">
                <Select value={rec.mode} onChange={e => setRec({ ...rec, mode: e.target.value })}>
                  {['neft', 'rtgs', 'upi', 'cheque', 'cash'].map(m => <option key={m} value={m}>{m.toUpperCase()}</option>)}
                </Select>
              </Field>
            </div>
            {pickedInvoice && +rec.amount > pickedInvoice.total - pickedInvoice.paid + 0.01 && (
              <p className="rounded-lg bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">
                Exceeds balance due ({fmt.inr(pickedInvoice.total - pickedInvoice.paid)}) on this invoice.
              </p>
            )}
            <Field label="Reference (UTR / cheque no)">
              <Input value={rec.reference} onChange={e => setRec({ ...rec, reference: e.target.value })} />
            </Field>
          </div>
        )}
      </Modal>

      {/* ── Invoiced items fulfilled → offer to mark complete ── */}
      <Modal open={!!completePrompt} onClose={() => setCompletePrompt(null)} title="Mark fulfilled items complete?"
        footer={<>
          <Button variant="secondary" onClick={() => setCompletePrompt(null)}>Not now</Button>
          <Button onClick={confirmComplete} disabled={!completePrompt || !Object.values(completePrompt.picked).some(Boolean)}>
            <FileText size={14} /> Mark Complete
          </Button>
        </>}>
        {completePrompt && (
          <div className="space-y-3">
            <p className="text-sm text-slate-600">
              These invoiced items are fully dispatched. Mark them complete to push them into their order's Completed roll-up
              (an order moves to <b>Completed</b> once all its items are complete).
            </p>
            <div className="divide-y divide-slate-100 rounded-xl border border-slate-200">
              {completePrompt.items.map(l => (
                <label key={l.order_line_id} className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-slate-50">
                  <input type="checkbox" checked={!!completePrompt.picked[l.order_line_id]} className="h-4 w-4 rounded border-gray-300 text-brand-500"
                    onChange={e => setCompletePrompt(p => ({ ...p, picked: { ...p.picked, [l.order_line_id]: e.target.checked } }))} />
                  <div className="min-w-0 flex-1">
                    <ProductIdentity row={l} compact meta={`PO ${l.po_number} · ${fmt.num(l.qty)} pcs · fully dispatched`} />
                  </div>
                </label>
              ))}
            </div>
          </div>
        )}
      </Modal>

      {/* ── Same-vehicle strength mix-up alarm — soft, never blocks ── */}
      <Modal open={!!clashPrompt} onClose={() => setClashPrompt(null)} title="Same-vehicle strength check"
        footer={<>
          <Button variant="secondary" onClick={() => setClashPrompt(null)}>Cancel</Button>
          <Button onClick={() => create(true)}><FileText size={14} /> Bill Anyway</Button>
        </>}>
        {clashPrompt && (
          <div className="space-y-3">
            <p className="flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-2.5 text-sm font-semibold text-amber-800">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              This invoice bills the same brand at two strengths that went out on the <b>same vehicle</b>.
            </p>
            <div className="rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-700">
              <div className="flex flex-wrap items-center gap-2">
                {clashPrompt.pair.map((p, i) => (
                  <span key={i} className="inline-flex items-baseline gap-1 rounded-lg bg-white px-2.5 py-1 shadow-sm">
                    <b className="text-slate-800">{p.product_name}</b>
                    {p.strength && <span className="rounded bg-amber-200/70 px-1.5 text-xs font-semibold text-amber-800">{p.strength}</span>}
                  </span>
                ))}
              </div>
              <div className="mt-2 text-xs text-slate-500">
                Vehicle <b>{clashPrompt.vehicle}</b>
                {clashPrompt.challans?.length ? ` · challan ${clashPrompt.challans.join(', ')}` : ''}
              </div>
            </div>
            <p className="text-xs text-slate-500">Different strengths of the same product can get swapped in transit. Sure they weren't mixed up before you bill?</p>
          </div>
        )}
      </Modal>
    </div>
  );
}
