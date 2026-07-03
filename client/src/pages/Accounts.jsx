// Accounts — who owes what (aging buckets) and every rupee received.
import { useEffect, useMemo, useState } from 'react';
import { api, fmt } from '../api.js';
import { Button, DataTable, Field, Input, KpiCard, Modal, PageHeader, Select, Tabs, Textarea, useToast } from '../components/ui.jsx';
import { Plus, Wallet, ReceiptText, AlertTriangle, TrendingUp } from 'lucide-react';

export default function Accounts() {
  const toast = useToast();
  const [tab, setTab] = useState('outstanding');
  const [outstanding, setOutstanding] = useState([]);
  const [payments, setPayments] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [rec, setRec] = useState(null); // record-payment form

  const load = () => {
    api.get('/accounts/outstanding').then(setOutstanding);
    api.get('/payments').then(setPayments);
    api.get('/invoices').then(setInvoices);
  };
  useEffect(() => { load(); }, []);

  const totals = useMemo(() => ({
    invoiced: outstanding.reduce((s, c) => s + c.invoiced, 0),
    collected: outstanding.reduce((s, c) => s + c.paid + c.on_account, 0),
    due: outstanding.reduce((s, c) => s + Math.max(0, c.outstanding), 0),
    overdue: outstanding.reduce((s, c) => s + c.b61_90 + c.b90p, 0),
  }), [outstanding]);

  const openInvoices = useMemo(
    () => invoices.filter(i => i.status === 'open' && i.customer_id === +(rec?.customer_id || 0)),
    [invoices, rec?.customer_id]);
  const customers = useMemo(() => {
    const seen = {};
    for (const i of invoices) seen[i.customer_id] = i.customer_name;
    return Object.entries(seen).map(([id, name]) => ({ id: +id, name }));
  }, [invoices]);
  const pickedInvoice = openInvoices.find(i => i.id === +(rec?.invoice_id || 0));

  const save = async () => {
    await api.post('/payments', {
      ...rec, customer_id: +rec.customer_id,
      invoice_id: rec.invoice_id ? +rec.invoice_id : null, amount: +rec.amount,
    });
    toast.success('Payment recorded');
    setRec(null); load();
  };

  const money = v => <span className="tabular-nums">{fmt.inr(v)}</span>;
  const bucket = v => v > 0.01
    ? <span className="font-semibold tabular-nums">{fmt.inr(v)}</span>
    : <span className="text-slate-300">—</span>;

  return (
    <div>
      <PageHeader title="Accounts" subtitle="Receivables, collections and customer ledger"
        actions={<Button onClick={() => setRec({ customer_id: '', invoice_id: '', amount: '', mode: 'neft', reference: '' })}
          disabled={!invoices.length}><Plus size={15} /> Record Payment</Button>} />

      <div className="mb-5 grid grid-cols-2 gap-3 xl:grid-cols-4">
        <KpiCard label="Total Invoiced" value={fmt.inr(totals.invoiced)} icon={ReceiptText} />
        <KpiCard label="Collected" value={fmt.inr(totals.collected)} icon={Wallet} chip="bg-emerald-50 text-emerald-600" accent="text-emerald-600" />
        <KpiCard label="Outstanding" value={fmt.inr(totals.due)} icon={TrendingUp} chip="bg-amber-50 text-amber-600" accent={totals.due > 0 ? 'text-amber-600' : 'text-slate-900'} />
        <KpiCard label="Overdue 60d+" value={fmt.inr(totals.overdue)} icon={AlertTriangle} chip="bg-red-50 text-red-500" accent={totals.overdue > 0 ? 'text-red-600' : 'text-slate-900'} />
      </div>

      <Tabs active={tab} onChange={setTab} tabs={[
        { key: 'outstanding', label: 'Outstanding by Customer', count: outstanding.filter(c => c.outstanding > 0.01).length },
        { key: 'payments', label: 'Payments Received', count: payments.length },
      ]} />

      {tab === 'outstanding' && (
        <DataTable rows={outstanding} empty="No invoices raised yet"
          columns={[
            { key: 'customer_name', label: 'Customer', render: c => (<div><div className="font-semibold">{c.customer_name}</div><div className="text-xs text-gray-400">{c.city}</div></div>) },
            { key: 'invoiced', label: 'Invoiced', align: 'right', render: c => money(c.invoiced) },
            { key: 'paid', label: 'Received', align: 'right', render: c => <span className="tabular-nums text-emerald-700">{fmt.inr(c.paid + c.on_account)}</span> },
            { key: 'b0_30', label: '0–30d', align: 'right', render: c => bucket(c.b0_30) },
            { key: 'b31_60', label: '31–60d', align: 'right', render: c => bucket(c.b31_60) },
            { key: 'b61_90', label: '61–90d', align: 'right', render: c => c.b61_90 > 0.01 ? <span className="font-semibold tabular-nums text-amber-600">{fmt.inr(c.b61_90)}</span> : <span className="text-slate-300">—</span> },
            { key: 'b90p', label: '90d+', align: 'right', render: c => c.b90p > 0.01 ? <span className="font-bold tabular-nums text-red-600">{fmt.inr(c.b90p)}</span> : <span className="text-slate-300">—</span> },
            { key: 'outstanding', label: 'Outstanding', align: 'right', render: c => (
              <span className={`font-bold tabular-nums ${c.outstanding > 0.01 ? 'text-slate-900' : 'text-emerald-600'}`}>{fmt.inr(Math.max(0, c.outstanding))}</span>) },
          ]} />
      )}

      {tab === 'payments' && (
        <DataTable searchable rows={payments} empty="No payments recorded yet"
          columns={[
            { key: 'payment_number', label: 'Receipt', render: p => <span className="font-semibold">{p.payment_number}</span> },
            { key: 'received_at', label: 'Received', render: p => fmt.dt(p.received_at) },
            { key: 'customer_name', label: 'Customer' },
            { key: 'invoice_number', label: 'Against', render: p => p.invoice_number || <span className="text-xs text-gray-400">on account</span> },
            { key: 'amount', label: 'Amount', align: 'right', render: p => <span className="font-bold tabular-nums text-emerald-700">{fmt.inr(p.amount)}</span> },
            { key: 'mode', label: 'Mode', render: p => <span className="text-xs uppercase text-gray-500">{p.mode}</span> },
            { key: 'reference', label: 'Reference', render: p => <span className="text-xs text-gray-500">{p.reference || '—'}</span> },
          ]} />
      )}

      <Modal open={!!rec} onClose={() => setRec(null)} title="Record Payment"
        footer={<>
          <Button variant="secondary" onClick={() => setRec(null)}>Cancel</Button>
          <Button onClick={save} disabled={!rec?.customer_id || !rec?.amount || +rec.amount <= 0}>Save Receipt</Button>
        </>}>
        {rec && (
          <div className="space-y-3">
            <Field label="Customer" required>
              <Select value={rec.customer_id} onChange={e => setRec({ ...rec, customer_id: e.target.value, invoice_id: '' })}>
                <option value="">Select…</option>
                {customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            </Field>
            <Field label="Against Invoice" hint="Leave blank to record on account">
              <Select value={rec.invoice_id} onChange={e => {
                const inv = openInvoices.find(i => i.id === +e.target.value);
                setRec({ ...rec, invoice_id: e.target.value, amount: inv ? String(+(inv.total - inv.paid).toFixed(2)) : rec.amount });
              }}>
                <option value="">On account</option>
                {openInvoices.map(i => <option key={i.id} value={i.id}>{i.invoice_number} — {fmt.inr(i.total - i.paid)} due</option>)}
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
    </div>
  );
}
