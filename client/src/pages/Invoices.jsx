// Invoices — cut GST tax invoices from dispatched challan lines.
// Pick a customer, tick the uninvoiced lines, the GST engine does the rest.
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmt } from '../api.js';
import { Button, Checkbox, DataTable, Field, Modal, PageHeader, Select, StatusBadge, Tabs, useToast } from '../components/ui.jsx';
import { Plus, FileText } from 'lucide-react';

export default function Invoices() {
  const toast = useToast();
  const [invoices, setInvoices] = useState([]);
  const [uninvoiced, setUninvoiced] = useState([]);
  const [creating, setCreating] = useState(false);
  const [customerId, setCustomerId] = useState('');
  const [picked, setPicked] = useState({});
  const [tab, setTab] = useState('open');

  const load = () => {
    api.get('/invoices').then(setInvoices);
    api.get('/billing/uninvoiced').then(setUninvoiced);
  };
  useEffect(() => { load(); }, []);

  const openInvoices = invoices.filter(i => i.status === 'open');
  const settledInvoices = invoices.filter(i => i.status !== 'open');

  const customers = useMemo(() => {
    const seen = {};
    for (const l of uninvoiced) seen[l.customer_id] = l.customer_name;
    return Object.entries(seen).map(([id, name]) => ({ id: +id, name }));
  }, [uninvoiced]);

  const lines = useMemo(
    () => uninvoiced.filter(l => l.customer_id === +customerId),
    [uninvoiced, customerId]);

  const selected = lines.filter(l => picked[l.dispatch_line_id]);
  const subtotal = selected.reduce((s, l) => s + l.amount, 0);
  const intra = selected[0] && (selected[0].state || '').trim().toLowerCase() === 'punjab';
  // per-line GST — each carton carries its own rate (5% / 12% / 18%)
  const tax = selected.reduce((s, l) => s + l.amount * (l.gst_pct ?? 12) / 100, 0);
  const grand = Math.round(subtotal + tax);
  const rates = [...new Set(selected.map(l => l.gst_pct ?? 12))].sort((a, b) => a - b);

  const create = async () => {
    const inv = await api.post('/invoices', {
      customer_id: +customerId,
      dispatch_line_ids: selected.map(l => l.dispatch_line_id),
    });
    toast.success(`Invoice ${inv.invoice_number} created — ₹${fmt.num(inv.total)}`);
    setCreating(false); setPicked({}); setCustomerId('');
    load();
  };

  return (
    <div>
      <PageHeader title="Invoices" subtitle="GST tax invoices from dispatched challans — place of supply decides CGST/SGST vs IGST"
        actions={<Button onClick={() => setCreating(true)} disabled={uninvoiced.length === 0}>
          <Plus size={15} /> New Invoice{uninvoiced.length > 0 && <span className="ml-1 rounded-full bg-white/25 px-1.5 text-xs">{uninvoiced.length} lines waiting</span>}
        </Button>} />
      <Tabs active={tab} onChange={setTab} tabs={[
        { key: 'open', label: 'Outstanding', count: openInvoices.length },
        { key: 'settled', label: 'Settled', count: settledInvoices.length },
      ]} />

      <DataTable searchable rows={tab === 'open' ? openInvoices : settledInvoices}
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
          { key: '_view', label: '', render: i => (
            <Link to={`/invoices/${i.id}`} onClick={e => e.stopPropagation()}
              className="inline-flex items-center gap-1 text-xs font-semibold text-gray-400 hover:text-brand-600"><FileText size={13} /> View</Link>) },
        ]} />

      <Modal wide open={creating} onClose={() => setCreating(false)} title="New Tax Invoice"
        footer={<>
          <Button variant="secondary" onClick={() => setCreating(false)}>Cancel</Button>
          <Button onClick={create} disabled={!selected.length}>
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
                {customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
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
                      <td className="px-3 py-2"><div className="font-semibold text-slate-800">{l.product_name}</div><div className="text-xs text-slate-400">PO {l.po_number}</div></td>
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
    </div>
  );
}
