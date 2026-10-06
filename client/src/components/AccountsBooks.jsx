// Accounts books — purchase bills, vendor payments, payables, the party ledger
// and the cash & bank book. The buying-side mirror of Invoices + Record Payment,
// and the two books that read both sides together. Rendered inside Accounts.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, fmt } from '../api.js';
import { Button, DataTable, Field, Input, Modal, PressButton, searchText, Select, useToast } from './ui.jsx';
import { Plus, Trash2, ShoppingBag, ArrowUpRight, ArrowDownLeft } from 'lucide-react';

const today = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, local
const MODES = ['neft', 'rtgs', 'upi', 'cheque', 'cash'];
const money = v => <span className="tabular-nums">{fmt.inr(v)}</span>;
const dash = <span className="text-gray-300">—</span>;
const blankLine = () => ({ key: Math.random().toString(36).slice(2), material_id: '', description: '', qty: '', rate: '', gst_pct: '0' });
// HTTP errors toast centrally (api.js); a network error has no response.
const netError = (toast, e, what) => { if (!e.data) toast.error(e.message || what); };

export const BOOK_TABS = [
  { key: 'payables', label: 'Payables' },
  { key: 'bills', label: 'Purchase Bills' },
  { key: 'cashbook', label: 'Cash & Bank Book' },
  { key: 'ledger', label: 'Party Ledger' },
];
export const isBookTab = k => BOOK_TABS.some(t => t.key === k);

// A name that opens that party's statement.
const partyLink = (label, onClick, sub) => (
  <div>
    <button type="button" onClick={e => { e.stopPropagation(); onClick(); }}
      className="text-left font-semibold text-slate-900 hover:text-brand-600 hover:underline">{label}</button>
    {sub && <div className="text-xs text-gray-400">{sub}</div>}
  </div>);
const monthLabel = ym => new Date(`${ym}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'short', year: '2-digit' });

export default function AccountsBooks({ view, from, to, periodLabel, party, onOpenLedger, onPickMonth, activeMonth }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [vendors, setVendors] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [items, setItems] = useState([]);
  const [bills, setBills] = useState([]);
  const [payables, setPayables] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [book, setBook] = useState({ opening: 0, entries: [], closing: 0 });
  // `party` ('customer:2' | 'vendor:5') is owned by Accounts, so a name clicked
  // in any register can open its statement here.
  const setParty = onOpenLedger;
  const [voucher, setVoucher] = useState(null); // the receipt / payment / bill being viewed
  const [ledger, setLedger] = useState(null);
  const [bill, setBill] = useState(null);   // purchase entry form
  const [pay, setPay] = useState(null);     // vendor payment form
  const [rec, setRec] = useState(null);     // customer receipt form

  const loadBook = () => {
    const qs = [from && `from=${from}`, to && `to=${to}`].filter(Boolean).join('&');
    api.get(`/accounts/cashbook${qs ? `?${qs}` : ''}`).then(setBook).catch(() => {});
  };
  const loadLedger = () => {
    if (!party) { setLedger(null); return; }
    const [type, id] = party.split(':');
    const qs = [from && `from=${from}`, to && `to=${to}`].filter(Boolean).map(x => `&${x}`).join('');
    api.get(`/accounts/ledger?party=${type}&id=${id}${qs}`).then(setLedger).catch(() => setLedger(null));
  };
  const load = () => {
    api.get('/purchase-bills').then(setBills).catch(() => {});
    api.get('/accounts/payables').then(setPayables).catch(() => {});
    api.get('/invoices').then(setInvoices).catch(() => {});
    loadBook(); loadLedger();
  };
  useEffect(() => {
    api.get('/vendors').then(vs => setVendors(vs.filter(v => v.active !== 0))).catch(() => {});
    api.get('/customers').then(cs => setCustomers(cs.filter(c => c.active !== 0))).catch(() => {});
    load();
  }, []);
  useEffect(loadBook, [from, to]);
  useEffect(loadLedger, [party, from, to]);
  // A name clicked in a register far up the page opens the statement down
  // here — bring it into view so the click visibly lands somewhere.
  const ledgerRef = useRef(null);
  useEffect(() => {
    if (view === 'ledger' && party) ledgerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [view, party]);

  const openVoucher = (type, id) => {
    api.get(`/accounts/voucher?type=${type}&id=${id}`).then(setVoucher)
      .catch(e => netError(toast, e, 'Could not open the voucher'));
  };
  // The number on any entry opens what it is: an invoice goes to the invoice
  // page, everything else opens its voucher here.
  const entryLink = (e, cls = 'font-bold text-brand-600 hover:underline') => (e.ref_type === 'invoice'
    ? <Link to={`/invoices/${e.ref_id}`} onClick={ev => ev.stopPropagation()} className={cls}>{e.number}</Link>
    : <button type="button" className={cls} onClick={ev => { ev.stopPropagation(); openVoucher(e.ref_type, e.ref_id); }}>{e.number}</button>);

  // ── Purchase entry ────────────────────────────────────────────────────────
  const openBill = () => {
    api.get('/direct-invoices/trading-items').then(setItems).catch(() => {});
    setBill({ vendor_id: '', vendor_bill_no: '', bill_date: today(), notes: '', lines: [blankLine()] });
  };
  const setBillLine = (key, patch) => setBill(b => ({ ...b, lines: b.lines.map(l => (l.key === key ? { ...l, ...patch } : l)) }));
  const billRows = (bill?.lines || []).map(l => {
    const it = items.find(i => i.id === +l.material_id);
    const amount = +((+l.qty || 0) * (+l.rate || 0)).toFixed(2);
    return { ...l, it, amount, ready: (+l.qty > 0) && l.rate !== '' && +l.rate >= 0 && (!!it || !!l.description.trim()) };
  });
  const billSub = billRows.reduce((s, l) => s + l.amount, 0);
  const billTax = billRows.reduce((s, l) => s + l.amount * (+l.gst_pct || 0) / 100, 0);
  const saveBill = async () => {
    try {
      const b = await api.post('/purchase-bills', {
        vendor_id: +bill.vendor_id, vendor_bill_no: bill.vendor_bill_no.trim() || undefined,
        bill_date: bill.bill_date || undefined, notes: bill.notes.trim() || undefined,
        lines: billRows.map(l => ({
          material_id: l.material_id ? +l.material_id : undefined,
          description: l.description.trim() || undefined,
          qty: +l.qty, rate: +l.rate, gst_pct: +l.gst_pct || 0,
        })),
      });
      toast.success(`${b.bill_number} saved — ${fmt.inr(b.total)}`);
      setBill(null); load();
    } catch (e) { netError(toast, e, 'Could not save the purchase'); }
  };
  const delBill = async b => {
    if (!window.confirm(`Delete purchase bill ${b.bill_number} (${fmt.inr(b.total)})?\n\nAny stock it brought in is taken back out. This cannot be undone.`)) return;
    try { await api.del(`/purchase-bills/${b.id}`); toast.success(`${b.bill_number} deleted`); load(); }
    catch (e) { netError(toast, e, 'Could not delete the bill'); }
  };

  // ── Vendor payment ────────────────────────────────────────────────────────
  const openPay = (vendorId = '', billRow = null) => setPay({
    vendor_id: String(vendorId || ''), purchase_bill_id: billRow ? String(billRow.id) : '',
    amount: billRow ? String(+(billRow.total - billRow.paid).toFixed(2)) : '', mode: 'neft', reference: '', paid_on: today(),
  });
  const openBills = useMemo(
    () => bills.filter(b => b.vendor_id === +(pay?.vendor_id || 0) && b.total - b.paid > 0.01), [bills, pay?.vendor_id]);
  const savePay = async () => {
    try {
      const p = await api.post('/vendor-payments', {
        ...pay, vendor_id: +pay.vendor_id, amount: +pay.amount,
        purchase_bill_id: pay.purchase_bill_id ? +pay.purchase_bill_id : null,
      });
      toast.success(`${p.payment_number} — ${fmt.inr(p.amount)} paid`);
      setPay(null); load();
    } catch (e) { netError(toast, e, 'Could not record the payment'); }
  };

  // ── Customer receipt (same record Invoices → Record Payment writes) ───────
  const openInvoices = useMemo(
    () => invoices.filter(i => i.status === 'open' && i.customer_id === +(rec?.customer_id || 0)), [invoices, rec?.customer_id]);
  const saveRec = async () => {
    try {
      const p = await api.post('/payments', {
        ...rec, customer_id: +rec.customer_id, amount: +rec.amount,
        invoice_id: rec.invoice_id ? +rec.invoice_id : null,
      });
      toast.success(`${p.payment_number} — ${fmt.inr(p.amount)} received`);
      setRec(null); load();
    } catch (e) { netError(toast, e, 'Could not record the receipt'); }
  };

  const delEntry = async e => {
    const isIn = e.direction === 'in';
    if (!window.confirm(`Delete ${isIn ? 'receipt' : 'payment'} ${e.number} (${fmt.inr(e.amount)})?\n\n${isIn ? 'The invoice it settled becomes outstanding again.' : 'The bill it paid becomes payable again.'}`)) return;
    try { await api.del(`/${isIn ? 'payments' : 'vendor-payments'}/${e.source_id}`); toast.success(`${e.number} deleted`); load(); }
    catch (err) { netError(toast, err, 'Could not delete the entry'); }
  };

  const actions = (
    <div className="mb-3 flex flex-wrap justify-end gap-2">
      <Button variant="secondary" onClick={() => setRec({ customer_id: '', invoice_id: '', amount: '', mode: 'neft', reference: '' })}>
        <ArrowDownLeft size={15} /> Record Receipt</Button>
      <Button variant="secondary" onClick={() => openPay()}><ArrowUpRight size={15} /> Pay Vendor</Button>
      <Button onClick={openBill}><ShoppingBag size={15} /> Purchase Entry</Button>
    </div>
  );

  const modeField = (state, set) => (
    <Field label="Mode">
      <Select value={state.mode} onChange={e => set({ ...state, mode: e.target.value })}>
        {MODES.map(m => <option key={m} value={m}>{m.toUpperCase()}</option>)}
      </Select>
    </Field>
  );

  return (
    <div>
      {actions}

      {view === 'payables' && (
        <DataTable searchable rows={payables} getRowId={v => v.vendor_id} defaultSort={{ key: 'outstanding', dir: 'desc' }} empty="Nothing owed — no purchase bills booked yet"
          columns={[
            { key: 'vendor_name', label: 'Vendor', render: v => partyLink(v.vendor_name, () => setParty(`vendor:${v.vendor_id}`), v.city) },
            { key: 'billed', label: 'Billed', align: 'right', render: v => money(v.billed) },
            { key: 'paid', label: 'Paid', align: 'right', render: v => money(v.paid + v.on_account) },
            { key: 'b0_30', label: '0–30 d', align: 'right', render: v => (v.b0_30 ? money(v.b0_30) : dash) },
            { key: 'b31_60', label: '31–60 d', align: 'right', render: v => (v.b31_60 ? money(v.b31_60) : dash) },
            { key: 'b61_90', label: '61–90 d', align: 'right', render: v => (v.b61_90 ? money(v.b61_90) : dash) },
            { key: 'b90p', label: '90+ d', align: 'right', render: v => (v.b90p ? <span className="font-semibold tabular-nums text-red-600">{fmt.inr(v.b90p)}</span> : dash) },
            { key: 'outstanding', label: 'We Owe', align: 'right', render: v => <span className={`font-bold tabular-nums ${v.outstanding > 0 ? 'text-red-700' : 'text-emerald-700'}`}>{fmt.inr(v.outstanding)}</span> },
            { key: '_act', label: '', render: v => (
              <div className="flex justify-end gap-3 text-xs font-semibold">
                <button type="button" className="text-gray-400 hover:text-brand-600" onClick={() => setParty(`vendor:${v.vendor_id}`)}>Ledger</button>
                <button type="button" className="text-brand-600 hover:underline" onClick={() => openPay(v.vendor_id)}>Pay</button>
              </div>) },
          ]}
          exportName="Vendor Payables" exportSubtitle="What each vendor is owed, aged from the bill date"
          exportSummary={rows => [
            { label: 'Vendors', value: rows.length },
            { label: 'We owe', value: fmt.inr(rows.reduce((s, v) => s + v.outstanding, 0)) },
          ]} />
      )}

      {view === 'bills' && (
        <DataTable searchable rows={bills} getRowId={b => b.id} defaultSort={{ key: 'id', dir: 'desc' }} empty="No purchase bills yet — use Purchase Entry"
          columns={[
            { key: 'bill_number', label: 'Bill', render: b => (<div>{entryLink({ ref_type: 'bill', ref_id: b.id, number: b.bill_number })}{b.vendor_bill_no && <div className="text-xs text-gray-400">Vendor bill {b.vendor_bill_no}</div>}</div>) },
            { key: 'bill_date', label: 'Date', render: b => fmt.date(b.bill_date) },
            { key: 'vendor_name', label: 'Vendor', render: b => partyLink(b.vendor_name, () => setParty(`vendor:${b.vendor_id}`), b.city) },
            { key: 'items', label: 'Items', render: b => <span className="text-xs text-gray-500">{b.items || '—'}</span> },
            { key: 'subtotal', label: 'Taxable', align: 'right', render: b => money(b.subtotal) },
            { key: 'tax', label: 'GST', align: 'right', render: b => <span className="tabular-nums text-xs text-gray-500">{fmt.inr(b.tax)}</span> },
            { key: 'total', label: 'Total', align: 'right', render: b => <span className="font-bold tabular-nums">{fmt.inr(b.total)}</span> },
            { key: 'paid', label: 'Paid', align: 'right', render: b => <span className={`tabular-nums ${b.paid >= b.total - 0.01 ? 'font-semibold text-emerald-600' : 'text-gray-500'}`}>{fmt.inr(b.paid)}</span> },
            { key: '_act', label: '', render: b => (
              <div className="flex items-center justify-end gap-3 text-xs font-semibold">
                {b.total - b.paid > 0.01 && <button type="button" className="text-brand-600 hover:underline" onClick={() => openPay(b.vendor_id, b)}>Pay</button>}
                <PressButton type="button" disabled={b.paid > 0} title={b.paid > 0 ? 'Delete the payment first' : 'Delete this bill'}
                  onClick={() => delBill(b)} className="inline-flex items-center gap-1 text-gray-400 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-30">
                  <Trash2 size={13} /> Delete</PressButton>
              </div>) },
          ]}
          exportName="Purchase Bills" exportSubtitle="Vendor bills booked in Accounts"
          exportSummary={rows => [
            { label: 'Bills', value: rows.length },
            { label: 'Total', value: fmt.inr(rows.reduce((s, b) => s + b.total, 0)) },
            { label: 'Paid', value: fmt.inr(rows.reduce((s, b) => s + b.paid, 0)) },
          ]} />
      )}

      {view === 'cashbook' && (
        <>
          <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[['Opening balance', book.opening], ['Money in', book.entries.reduce((s, e) => s + e.money_in, 0)],
              ['Money out', book.entries.reduce((s, e) => s + e.money_out, 0)], ['Closing balance', book.closing]].map(([label, v]) => (
              <div key={label} className="rounded-2xl border border-slate-100 bg-white px-4 py-3 shadow-sm">
                <div className="text-[11px] font-bold uppercase tracking-wide text-slate-400">{label}</div>
                <div className={`mt-0.5 text-lg font-extrabold tabular-nums ${v < 0 ? 'text-red-700' : 'text-slate-900'}`}>{fmt.inr(v)}</div>
              </div>))}
          </div>
          <DataTable searchable rows={book.entries} getRowId={e => e.id} empty={`No money in or out · ${periodLabel}`}
            columns={[
              { key: 'date', sortable: false, label: 'Date', render: e => fmt.date(e.date) },
              { key: 'number', sortable: false, label: 'Voucher', render: e => entryLink(e) },
              { key: 'party', sortable: false, label: 'Party', render: e => partyLink(e.party, () => setParty(e.party_key),
                `${e.direction === 'in' ? 'Receipt from customer' : 'Payment to vendor'}${e.against ? ` · ${e.against}` : ' · on account'}`) },
              { key: 'mode', sortable: false, label: 'Mode', render: e => <span className="text-xs font-semibold uppercase text-slate-500">{e.mode}{e.reference ? ` · ${e.reference}` : ''}</span> },
              { key: 'money_in', sortable: false, label: 'In', align: 'right', render: e => (e.money_in ? <span className="font-semibold tabular-nums text-emerald-700">{fmt.inr(e.money_in)}</span> : dash) },
              { key: 'money_out', sortable: false, label: 'Out', align: 'right', render: e => (e.money_out ? <span className="font-semibold tabular-nums text-red-700">{fmt.inr(e.money_out)}</span> : dash) },
              { key: 'balance', sortable: false, label: 'Balance', align: 'right', render: e => <span className="font-bold tabular-nums">{fmt.inr(e.balance)}</span> },
              { key: '_act', sortable: false, label: '', render: e => (
                <PressButton type="button" title="Delete this entry" onClick={() => delEntry(e)}
                  className="text-gray-300 hover:text-red-600"><Trash2 size={13} /></PressButton>) },
            ]}
            exportName="Cash & Bank Book" exportSubtitle={`Accounts · ${periodLabel}`}
            exportSummary={() => [
              { label: 'Opening', value: fmt.inr(book.opening) },
              { label: 'In', value: fmt.inr(book.entries.reduce((s, e) => s + e.money_in, 0)) },
              { label: 'Out', value: fmt.inr(book.entries.reduce((s, e) => s + e.money_out, 0)) },
              { label: 'Closing', value: fmt.inr(book.closing) },
            ]} />
        </>
      )}

      {view === 'ledger' && (
        <div ref={ledgerRef} className="scroll-mt-4">
          <div className="mb-3 flex flex-wrap items-end gap-3">
            <Field label="Party" className="w-80 max-w-full">
              <Select value={party} onChange={e => setParty(e.target.value)}>
                <option value="">Select a customer or vendor…</option>
                {customers.map(c => <option key={`c${c.id}`} value={`customer:${c.id}`} data-search={searchText(c)}>{c.name} — customer</option>)}
                {vendors.map(v => <option key={`v${v.id}`} value={`vendor:${v.id}`} data-search={searchText(v)}>{v.name} — vendor</option>)}
              </Select>
            </Field>
            {ledger && [
              ['Opening balance', ledger.opening, false],
              [ledger.party.type === 'vendor' ? 'Billed to us' : 'Invoiced', ledger.entries.reduce((s, e) => s + (ledger.party.type === 'vendor' ? e.credit : e.debit), 0), false],
              [ledger.party.type === 'vendor' ? 'Paid' : 'Received', ledger.entries.reduce((s, e) => s + (ledger.party.type === 'vendor' ? e.debit : e.credit), 0), false],
              [ledger.party.type === 'vendor' ? 'We owe' : 'They owe us', ledger.balance, true],
            ].map(([label, v, closing]) => (
              <div key={label} className="rounded-2xl border border-slate-100 bg-white px-4 py-2 shadow-sm">
                <div className="text-[11px] font-bold uppercase tracking-wide text-slate-400">{label}</div>
                <div className={`text-lg font-extrabold tabular-nums ${closing ? (v > 0 ? 'text-red-700' : 'text-emerald-700') : 'text-slate-900'}`}>{fmt.inr(v)}</div>
              </div>
            ))}
          </div>

          {/* The party's own month-by-month timeline — click a month to see just it. */}
          {ledger && ledger.monthly.length > 0 && (() => {
            const months = ledger.monthly.slice(-12);
            const max = Math.max(1, ...months.map(m => Math.max(m.debit, m.credit)));
            const vendor = ledger.party.type === 'vendor';
            return (
              <div className="mb-3 rounded-2xl border border-slate-100 bg-white p-4 shadow-sm">
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="text-sm font-bold text-slate-700">{ledger.party.name} — statement of account · {periodLabel}</h3>
                  <div className="flex items-center gap-4 text-xs text-gray-500">
                    <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-indigo-400" /> {vendor ? 'Paid' : 'Invoiced'}</span>
                    <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-emerald-400" /> {vendor ? 'Billed to us' : 'Received'}</span>
                  </div>
                </div>
                <div className="flex gap-2 overflow-x-auto">
                  {months.map(m => (
                    <button key={m.month} type="button" onClick={() => onPickMonth(m.month)}
                      title={`${monthLabel(m.month)} — debit ${fmt.inr(m.debit)} · credit ${fmt.inr(m.credit)}`}
                      className={`w-16 shrink-0 rounded-lg border px-1 pb-1.5 pt-2 transition ${activeMonth === m.month ? 'border-brand-300 bg-brand-50' : 'border-transparent hover:border-slate-200 hover:bg-slate-50'}`}>
                      <div className="flex h-12 items-end justify-center gap-1">
                        <div className="w-2.5 rounded-t bg-indigo-400" style={{ height: `${Math.max(m.debit > 0 ? 8 : 2, 100 * m.debit / max)}%` }} />
                        <div className="w-2.5 rounded-t bg-emerald-400" style={{ height: `${Math.max(m.credit > 0 ? 8 : 2, 100 * m.credit / max)}%` }} />
                      </div>
                      <div className="mt-1 text-center text-[10px] font-semibold text-gray-400">{monthLabel(m.month)}</div>
                    </button>
                  ))}
                </div>
              </div>
            );
          })()}

          {ledger ? (
            <DataTable rows={ledger.entries} getRowId={e => `${e.ref_type}-${e.ref_id}`}
              onRowClick={e => (e.ref_type === 'invoice' ? navigate(`/invoices/${e.ref_id}`) : openVoucher(e.ref_type, e.ref_id))}
              empty={`No transactions with ${ledger.party.name} · ${periodLabel}`}
              columns={[
                { key: 'date', sortable: false, label: 'Date', render: e => fmt.date(e.date) },
                { key: 'kind', sortable: false, label: 'Particulars', render: e => (<div><span className="font-semibold">{e.kind}</span> {entryLink(e)}{e.reference && <div className="text-xs text-gray-400">{e.reference}</div>}</div>) },
                { key: 'debit', sortable: false, label: 'Debit', align: 'right', render: e => (e.debit ? money(e.debit) : dash) },
                { key: 'credit', sortable: false, label: 'Credit', align: 'right', render: e => (e.credit ? money(e.credit) : dash) },
                { key: 'balance', sortable: false, label: 'Balance', align: 'right', render: e => <span className="font-bold tabular-nums">{fmt.inr(e.balance)}</span> },
              ]}
              exportName={`Statement of Account — ${ledger.party.name}`}
              exportSubtitle={[periodLabel, ledger.party.city, ledger.party.state, ledger.party.gstin && `GSTIN ${ledger.party.gstin}`].filter(Boolean).join(' · ')}
              exportSummary={rows => [
                { label: 'Opening', value: fmt.inr(ledger.opening) },
                { label: 'Debit', value: fmt.inr(rows.reduce((s, e) => s + e.debit, 0)) },
                { label: 'Credit', value: fmt.inr(rows.reduce((s, e) => s + e.credit, 0)) },
                { label: ledger.party.type === 'vendor' ? 'We owe' : 'They owe us', value: fmt.inr(ledger.balance) },
              ]} />
          ) : (
            <p className="rounded-2xl border border-dashed border-slate-200 bg-white px-4 py-8 text-center text-sm text-slate-400">
              Pick a party — or click any customer or vendor name in Accounts — to see every invoice, bill, receipt and payment with a running balance.</p>
          )}
        </div>
      )}

      {/* ── Voucher — one receipt, payment or purchase bill ── */}
      <Modal open={!!voucher} onClose={() => setVoucher(null)} title={voucher ? `${voucher.title} ${voucher.number}` : ''}
        footer={<>
          {voucher && <Button variant="secondary" onClick={() => { const k = `${voucher.party_type}:${voucher.party_id}`; setVoucher(null); setParty(k); }}>Open {voucher.party}'s ledger</Button>}
          <Button onClick={() => setVoucher(null)}>Close</Button>
        </>}>
        {voucher && (
          <div className="space-y-3 text-sm">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-xs font-bold uppercase tracking-wide text-gray-400">{voucher.party_type === 'vendor' ? 'Vendor' : 'Customer'}</div>
                <div className="font-bold text-gray-900">{voucher.party}</div>
                <div className="text-xs text-gray-500">{[voucher.city, voucher.gstin && `GSTIN ${voucher.gstin}`].filter(Boolean).join(' · ')}</div>
              </div>
              <div className="text-right">
                <div className="text-xs text-gray-500">{fmt.date(voucher.date)}</div>
                <div className="text-xl font-extrabold tabular-nums text-slate-900">{fmt.inr(voucher.amount)}</div>
              </div>
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-xl bg-slate-50 px-4 py-3 text-xs">
              {voucher.mode && <><dt className="text-gray-500">Mode</dt><dd className="text-right font-semibold uppercase">{voucher.mode}</dd></>}
              {voucher.type !== 'bill' && <><dt className="text-gray-500">Against</dt><dd className="text-right font-semibold">
                {voucher.against_invoice_id ? <Link className="text-brand-600 hover:underline" to={`/invoices/${voucher.against_invoice_id}`}>{voucher.against}</Link>
                  : voucher.against_bill_id ? <button type="button" className="text-brand-600 hover:underline" onClick={() => openVoucher('bill', voucher.against_bill_id)}>{voucher.against}</button>
                  : 'On account'}</dd></>}
              {voucher.reference && <><dt className="text-gray-500">{voucher.type === 'bill' ? 'Vendor bill no' : 'Reference'}</dt><dd className="text-right font-semibold">{voucher.reference}</dd></>}
              {voucher.created_by && <><dt className="text-gray-500">Entered by</dt><dd className="text-right font-semibold">{voucher.created_by}</dd></>}
              {voucher.notes && <><dt className="text-gray-500">Notes</dt><dd className="text-right">{voucher.notes}</dd></>}
            </dl>
            {voucher.type === 'bill' && (<>
              <table className="w-full text-xs">
                <thead><tr className="ci-table-head"><th className="px-2 py-1.5">Item</th><th className="px-2 py-1.5 text-right">Qty</th><th className="px-2 py-1.5 text-right">Rate</th><th className="px-2 py-1.5 text-right">GST</th><th className="px-2 py-1.5 text-right">Amount</th></tr></thead>
                <tbody>{voucher.lines.map((l, i) => (
                  <tr key={i} className="border-b border-slate-100">
                    <td className="px-2 py-1.5 font-semibold">{l.description}{l.material_id ? <span className="ml-1 font-normal text-gray-400">· into stock</span> : null}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{(+l.qty).toLocaleString('en-IN')} {l.unit || ''}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">₹{(+l.rate).toFixed(2)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-gray-500">{l.gst_pct}%</td>
                    <td className="px-2 py-1.5 text-right font-semibold tabular-nums">{fmt.inr(l.amount)}</td>
                  </tr>))}</tbody>
              </table>
              <div className="ml-auto w-56 space-y-0.5 text-xs">
                <div className="flex justify-between text-gray-600"><span>Taxable</span><span className="tabular-nums">{fmt.inr(voucher.subtotal)}</span></div>
                <div className="flex justify-between text-gray-600"><span>GST</span><span className="tabular-nums">{fmt.inr(voucher.tax)}</span></div>
                <div className="flex justify-between border-t border-slate-200 pt-1 font-bold"><span>Total</span><span className="tabular-nums">{fmt.inr(voucher.amount)}</span></div>
                <div className="flex justify-between text-gray-600"><span>Paid</span><span className="tabular-nums">{fmt.inr(voucher.paid)}</span></div>
                <div className="flex justify-between font-bold text-red-700"><span>Balance</span><span className="tabular-nums">{fmt.inr(voucher.amount - voucher.paid)}</span></div>
              </div>
              {voucher.payments.length > 0 && (
                <div className="text-xs text-gray-500">Payments: {voucher.payments.map(p => (
                  <button key={p.id} type="button" className="mr-2 font-semibold text-brand-600 hover:underline" onClick={() => openVoucher('payment', p.id)}>
                    {p.payment_number} ({fmt.inr(p.amount)})</button>))}</div>
              )}
            </>)}
          </div>
        )}
      </Modal>

      {/* ── Purchase entry ── */}
      <Modal wide open={!!bill} onClose={() => setBill(null)} title="Purchase Entry — vendor bill"
        footer={<>
          <Button variant="secondary" onClick={() => setBill(null)}>Cancel</Button>
          <Button onClick={saveBill} disabled={!bill?.vendor_id || !billRows.length || !billRows.every(l => l.ready)}>
            Save Purchase{billSub > 0 && ` — ${fmt.inr(Math.round(billSub + billTax))}`}</Button>
        </>}>
        {bill && (
          <div className="space-y-4">
            <section className="ci-form-panel">
              <div className="ci-form-panel-title"><span>Vendor</span><span>Creates the payable · trading items land in stock</span></div>
              <div className="grid gap-3 sm:grid-cols-4">
                <Field label="Bought from" required className="sm:col-span-2">
                  <Select value={bill.vendor_id} onChange={e => setBill({ ...bill, vendor_id: e.target.value })}>
                    <option value="">Select vendor…</option>
                    {vendors.map(v => <option key={v.id} value={v.id} data-search={searchText(v)}>{v.name}</option>)}
                  </Select>
                </Field>
                <Field label="Vendor bill no"><Input value={bill.vendor_bill_no} onChange={e => setBill({ ...bill, vendor_bill_no: e.target.value })} /></Field>
                <Field label="Bill date"><Input type="date" value={bill.bill_date} onChange={e => setBill({ ...bill, bill_date: e.target.value })} /></Field>
              </div>
            </section>
            <section className="ci-data-panel">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="ci-table-head">
                    <th className="px-3 py-2 min-w-[14rem]">Trading item</th><th className="px-3 py-2 min-w-[12rem]">or description</th>
                    <th className="px-3 py-2 w-28 text-right">Qty</th><th className="px-3 py-2 w-28 text-right">Rate</th>
                    <th className="px-3 py-2 w-20 text-right">GST %</th><th className="px-3 py-2 w-28 text-right">Amount</th><th className="w-8" />
                  </tr></thead>
                  <tbody>
                    {billRows.map(l => (
                      <tr key={l.key} className="border-b border-slate-100 align-top">
                        <td className="px-3 py-2">
                          <Select value={l.material_id} onChange={e => setBillLine(l.key, { material_id: e.target.value })}>
                            <option value="">No stock — value only</option>
                            {items.filter(i => i.active !== 0).map(i => <option key={i.id} value={i.id} data-search={searchText(i)}>{i.name} ({i.unit})</option>)}
                          </Select>
                          {l.it && <div className="mt-1 text-xs text-slate-400">Adds to stock · now {(+l.it.in_stock || 0).toLocaleString('en-IN')} {l.it.unit}</div>}
                        </td>
                        <td className="px-3 py-2"><Input value={l.description} onChange={e => setBillLine(l.key, { description: e.target.value })}
                          placeholder={l.it ? l.it.name : 'e.g. Board bill for GRN, freight'} /></td>
                        <td className="px-3 py-2"><Input className="text-right" type="number" min="0" value={l.qty} onChange={e => setBillLine(l.key, { qty: e.target.value })} /></td>
                        <td className="px-3 py-2"><Input className="text-right" type="number" min="0" value={l.rate} onChange={e => setBillLine(l.key, { rate: e.target.value })} /></td>
                        <td className="px-3 py-2"><Input className="text-right" type="number" min="0" value={l.gst_pct} onChange={e => setBillLine(l.key, { gst_pct: e.target.value })} /></td>
                        <td className="px-3 py-2 pt-4 text-right font-semibold tabular-nums">{fmt.inr(l.amount)}</td>
                        <td className="px-3 py-2 pt-4">{billRows.length > 1 && (
                          <button type="button" title="Remove this line" className="text-slate-400 hover:text-red-600"
                            onClick={() => setBill(b => ({ ...b, lines: b.lines.filter(x => x.key !== l.key) }))}><Trash2 size={15} /></button>)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="px-4 py-3">
                <Button size="sm" variant="secondary" onClick={() => setBill(b => ({ ...b, lines: [...b.lines, blankLine()] }))}><Plus size={14} /> Add line</Button>
              </div>
            </section>
            {billSub > 0 && (
              <div className="ci-summary-panel">
                <div className="flex justify-between text-slate-600"><span>Taxable value</span><b className="tabular-nums">{fmt.inr(billSub)}</b></div>
                <div className="flex justify-between text-slate-600"><span>GST</span><b className="tabular-nums">{fmt.inr(billTax)}</b></div>
                <div className="mt-1 flex justify-between border-t border-slate-200 pt-1 text-slate-900"><span className="font-bold">Bill total (rounded)</span><b className="tabular-nums">{fmt.inr(Math.round(billSub + billTax))}</b></div>
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* ── Pay vendor ── */}
      <Modal open={!!pay} onClose={() => setPay(null)} title="Pay Vendor"
        footer={<>
          <Button variant="secondary" onClick={() => setPay(null)}>Cancel</Button>
          <Button onClick={savePay} disabled={!pay?.vendor_id || !(+pay?.amount > 0)}>Save Payment</Button>
        </>}>
        {pay && (
          <div className="space-y-3">
            <Field label="Vendor" required>
              <Select value={pay.vendor_id} onChange={e => setPay({ ...pay, vendor_id: e.target.value, purchase_bill_id: '' })}>
                <option value="">Select…</option>
                {vendors.map(v => <option key={v.id} value={v.id} data-search={searchText(v)}>{v.name}</option>)}
              </Select>
            </Field>
            <Field label="Against bill" hint="Leave blank to pay on account">
              <Select value={pay.purchase_bill_id} onChange={e => {
                const b = openBills.find(x => x.id === +e.target.value);
                setPay({ ...pay, purchase_bill_id: e.target.value, amount: b ? String(+(b.total - b.paid).toFixed(2)) : pay.amount });
              }}>
                <option value="">On account</option>
                {openBills.map(b => <option key={b.id} value={b.id}>{b.bill_number}{b.vendor_bill_no ? ` (${b.vendor_bill_no})` : ''} — {fmt.inr(b.total - b.paid)} due</option>)}
              </Select>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Amount (₹)" required><Input type="number" min="0" value={pay.amount} onChange={e => setPay({ ...pay, amount: e.target.value })} /></Field>
              {modeField(pay, setPay)}
              <Field label="Paid on"><Input type="date" value={pay.paid_on} onChange={e => setPay({ ...pay, paid_on: e.target.value })} /></Field>
              <Field label="Reference (UTR / cheque no)"><Input value={pay.reference} onChange={e => setPay({ ...pay, reference: e.target.value })} /></Field>
            </div>
          </div>
        )}
      </Modal>

      {/* ── Customer receipt ── */}
      <Modal open={!!rec} onClose={() => setRec(null)} title="Record Receipt"
        footer={<>
          <Button variant="secondary" onClick={() => setRec(null)}>Cancel</Button>
          <Button onClick={saveRec} disabled={!rec?.customer_id || !(+rec?.amount > 0)}>Save Receipt</Button>
        </>}>
        {rec && (
          <div className="space-y-3">
            <Field label="Customer" required>
              <Select value={rec.customer_id} onChange={e => setRec({ ...rec, customer_id: e.target.value, invoice_id: '' })}>
                <option value="">Select…</option>
                {customers.map(c => <option key={c.id} value={c.id} data-search={searchText(c)}>{c.name}</option>)}
              </Select>
            </Field>
            <Field label="Against invoice" hint="Leave blank to receive on account">
              <Select value={rec.invoice_id} onChange={e => {
                const i = openInvoices.find(x => x.id === +e.target.value);
                setRec({ ...rec, invoice_id: e.target.value, amount: i ? String(+(i.total - i.paid).toFixed(2)) : rec.amount });
              }}>
                <option value="">On account</option>
                {openInvoices.map(i => <option key={i.id} value={i.id}>{i.invoice_number} — {fmt.inr(i.total - i.paid)} due</option>)}
              </Select>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Amount (₹)" required><Input type="number" min="0" value={rec.amount} onChange={e => setRec({ ...rec, amount: e.target.value })} /></Field>
              {modeField(rec, setRec)}
            </div>
            <Field label="Reference (UTR / cheque no)"><Input value={rec.reference} onChange={e => setRec({ ...rec, reference: e.target.value })} /></Field>
          </div>
        )}
      </Modal>
    </div>
  );
}
