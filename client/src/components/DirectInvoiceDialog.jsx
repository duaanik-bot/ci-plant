// Direct Invoice — bill a party straight from stock, for trading.
// No order, job card or challan: pick the party, pick board from the warehouse
// or cartons from FG, and saving both raises the invoice and takes the goods
// off the book. Deleting the invoice puts them back.
import { useEffect, useMemo, useState } from 'react';
import { api, fmt } from '../api.js';
import { Button, Field, Input, Modal, searchText, Select, useToast } from './ui.jsx';
import { Plus, Trash2, UserPlus } from 'lucide-react';

const today = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, local
const blankLine = () => ({ key: Math.random().toString(36).slice(2), item_type: 'board', item_id: '', hsn: '', qty: '', rate: '', gst_pct: '' });
const blankParty = () => ({ name: '', gstin: '', state: 'Punjab', city: '' });
const qtyText = n => (+n || 0).toLocaleString('en-IN', { maximumFractionDigits: 3 });

export default function DirectInvoiceDialog({ open, onClose, onCreated }) {
  const toast = useToast();
  const [customers, setCustomers] = useState([]);
  const [items, setItems] = useState({ boards: [], cartons: [] });
  const [customerId, setCustomerId] = useState('');
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [invoiceDate, setInvoiceDate] = useState(today());
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState([blankLine()]);
  const [party, setParty] = useState(null); // quick-add form, when open

  // Re-read everything each time the dialog opens: stock and the next number
  // both move while it is closed.
  useEffect(() => {
    if (!open) return;
    setCustomerId(''); setInvoiceNumber(''); setInvoiceDate(today()); setNotes('');
    setLines([blankLine()]); setParty(null);
    api.get('/customers').then(cs => setCustomers(cs.filter(c => c.active !== 0))).catch(() => {});
    api.get('/direct-invoices/items').then(setItems).catch(() => {});
    api.get('/direct-invoices/next-number').then(r => setInvoiceNumber(r.invoice_number || '')).catch(() => {});
  }, [open]);

  const find = l => (l.item_type === 'board'
    ? items.boards.find(b => b.material_id === +l.item_id)
    : items.cartons.find(c => c.product_id === +l.item_id));

  const setLine = (key, patch) => setLines(ls => ls.map(l => (l.key === key ? { ...l, ...patch } : l)));
  // Picking an item pre-fills its rate and GST — both stay editable.
  const pickItem = (l, id) => {
    const it = (l.item_type === 'board' ? items.boards.find(b => b.material_id === +id) : items.cartons.find(c => c.product_id === +id));
    setLine(l.key, {
      item_id: id,
      hsn: it?.hsn || '',
      rate: it?.rate != null && +it.rate > 0 ? String(it.rate) : '',
      gst_pct: it ? String(+it.gst_pct > 0 ? it.gst_pct : 12) : '',
    });
  };

  // The same item on two rows draws on one shelf, so "over stock" is judged on
  // the running total, not row by row.
  const rows = useMemo(() => {
    const used = {};
    return lines.map(l => {
      const it = find(l);
      const k = `${l.item_type}:${l.item_id}`;
      const qty = +l.qty || 0;
      used[k] = (used[k] || 0) + qty;
      const amount = +(qty * (+l.rate || 0)).toFixed(2);
      return { ...l, it, amount, over: !!it && used[k] > +it.available + 1e-6,
        ready: !!it && qty > 0 && l.rate !== '' && +l.rate >= 0 };
    });
  }, [lines, items]);

  const subtotal = rows.reduce((s, l) => s + l.amount, 0);
  const tax = rows.reduce((s, l) => s + l.amount * (+l.gst_pct || 0) / 100, 0);
  const canSave = !!customerId && rows.length > 0 && rows.every(l => l.ready && !l.over);

  const saveParty = async () => {
    try {
      const c = await api.post('/customers', {
        name: party.name.trim(), gstin: party.gstin.trim().toUpperCase() || null,
        state: party.state.trim() || null, city: party.city.trim() || null,
      });
      setCustomers(cs => [...cs, c].sort((a, b) => a.name.localeCompare(b.name)));
      setCustomerId(String(c.id));
      setParty(null);
      toast.success(`${c.name} added`);
    } catch (e) { if (!e.data) toast.error(e.message || 'Could not add the party'); }
  };

  const save = async () => {
    let inv;
    try {
      inv = await api.post('/direct-invoices', {
        customer_id: +customerId,
        invoice_number: invoiceNumber.trim() || undefined,
        invoice_date: invoiceDate || undefined,
        notes: notes.trim() || undefined,
        lines: rows.map(l => ({
          item_type: l.item_type,
          [l.item_type === 'board' ? 'material_id' : 'product_id']: +l.item_id,
          hsn: l.hsn.trim() || undefined,
          qty: +l.qty, rate: +l.rate, gst_pct: +l.gst_pct || 0,
        })),
      });
    } catch (e) {
      // HTTP errors toast centrally (api.js); a network error has no response.
      if (!e.data) toast.error(e.message || 'Could not create the invoice');
      // Stock may have moved under the dialog — show the fresh figures.
      api.get('/direct-invoices/items').then(setItems).catch(() => {});
      return;
    }
    toast.success(`Invoice ${inv.invoice_number} created — ₹${fmt.num(inv.total)}`);
    onCreated?.(inv);
    onClose();
  };

  return (
    <Modal wide open={open} onClose={onClose} title="Direct Invoice — from stock"
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button onClick={save} disabled={!canSave}>
          Create Invoice{subtotal > 0 && ` — ${fmt.inr(subtotal + tax)}`}
        </Button>
      </>}>
      <div className="space-y-4">
        <section className="ci-form-panel">
          <div className="ci-form-panel-title">
            <span>Party</span>
            <span>Trading sale — no order, job card or challan</span>
          </div>
          <div className="grid gap-3 sm:grid-cols-4">
            <Field label="Bill to" required className="sm:col-span-2">
              <div className="flex gap-2">
                <div className="min-w-0 flex-1">
                  <Select value={customerId} onChange={e => setCustomerId(e.target.value)}>
                    <option value="">Select party…</option>
                    {customers.map(c => <option key={c.id} value={c.id} data-search={searchText(c)}>{c.name}</option>)}
                  </Select>
                </div>
                <Button variant="secondary" title="Add a new party" onClick={() => setParty(p => (p ? null : blankParty()))}>
                  <UserPlus size={15} /> New
                </Button>
              </div>
            </Field>
            <Field label="Invoice No" hint="Next in the CI-TRD series — type over it to change.">
              <Input value={invoiceNumber} onChange={e => setInvoiceNumber(e.target.value)} placeholder="CI-TRD-…" />
            </Field>
            <Field label="Date">
              <Input type="date" value={invoiceDate} onChange={e => setInvoiceDate(e.target.value)} />
            </Field>
          </div>
          {party && (
            <div className="mt-3 grid gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3 sm:grid-cols-5">
              <Field label="Party name" required className="sm:col-span-2">
                <Input value={party.name} onChange={e => setParty({ ...party, name: e.target.value })} />
              </Field>
              <Field label="GSTIN"><Input value={party.gstin} onChange={e => setParty({ ...party, gstin: e.target.value })} /></Field>
              <Field label="State" hint="Decides CGST+SGST vs IGST">
                <Input value={party.state} onChange={e => setParty({ ...party, state: e.target.value })} />
              </Field>
              <Field label="City"><Input value={party.city} onChange={e => setParty({ ...party, city: e.target.value })} /></Field>
              <div className="flex justify-end gap-2 sm:col-span-5">
                <Button size="sm" variant="secondary" onClick={() => setParty(null)}>Cancel</Button>
                <Button size="sm" onClick={saveParty} disabled={!party.name.trim()}>Save party</Button>
              </div>
            </div>
          )}
        </section>

        <section className="ci-data-panel">
          <div className="ci-form-panel-title m-0 border-b border-slate-100 px-4 py-3">
            <span>Items from stock</span>
            <span>{items.boards.length} materials · {items.cartons.length} cartons in stock</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="ci-table-head">
                <th className="px-3 py-2 w-44 min-w-[11rem]">From</th><th className="px-3 py-2 min-w-[16rem]">Item</th>
                <th className="px-3 py-2 w-28">HSN</th>
                <th className="px-3 py-2 w-28 text-right">Qty</th><th className="px-3 py-2 w-28 text-right">Rate</th>
                <th className="px-3 py-2 w-20 text-right">GST %</th><th className="px-3 py-2 w-28 text-right">Amount</th>
                <th className="px-3 py-2 w-8" />
              </tr></thead>
              <tbody>
                {rows.map(l => (
                  <tr key={l.key} className="border-b border-slate-100 align-top">
                    <td className="px-3 py-2">
                      <Select value={l.item_type} onChange={e => setLine(l.key, { item_type: e.target.value, item_id: '', hsn: '', rate: '', gst_pct: '' })}>
                        <option value="board">Board / RM</option>
                        <option value="carton">Carton (FG)</option>
                      </Select>
                    </td>
                    <td className="px-3 py-2">
                      <Select value={l.item_id} onChange={e => pickItem(l, e.target.value)}>
                        <option value="">{l.item_type === 'board' ? 'Select board / material…' : 'Select carton…'}</option>
                        {l.item_type === 'board'
                          ? items.boards.map(b => (
                            <option key={b.material_id} value={b.material_id} data-search={searchText(b)}>
                              {b.name} — {qtyText(b.available)} {b.unit}
                            </option>))
                          : items.cartons.map(c => (
                            <option key={c.product_id} value={c.product_id} data-search={searchText(c)}>
                              {c.name} · {c.code} — {qtyText(c.available)} pcs
                            </option>))}
                      </Select>
                      {l.it && (
                        <div className={`mt-1 text-xs ${l.over ? 'font-semibold text-red-600' : 'text-slate-400'}`}>
                          {l.over ? 'More than stock — ' : 'In stock: '}
                          {qtyText(l.it.available)} {l.item_type === 'board' ? l.it.unit : 'pcs'}
                          {l.item_type === 'carton' && l.it.customer_name ? ` · ${l.it.customer_name}` : ''}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2"><Input value={l.hsn} onChange={e => setLine(l.key, { hsn: e.target.value })}
                      placeholder={l.item_type === 'carton' ? 'Carton HSN' : 'HSN'} title={l.item_type === 'carton' ? 'Blank uses the carton HSN on your letterhead' : 'From the material master — type to change'} /></td>
                    <td className="px-3 py-2"><Input className="text-right" type="number" min="0" value={l.qty} onChange={e => setLine(l.key, { qty: e.target.value })} /></td>
                    <td className="px-3 py-2"><Input className="text-right" type="number" min="0" value={l.rate} onChange={e => setLine(l.key, { rate: e.target.value })} /></td>
                    <td className="px-3 py-2"><Input className="text-right" type="number" min="0" value={l.gst_pct} onChange={e => setLine(l.key, { gst_pct: e.target.value })} /></td>
                    <td className="px-3 py-2 pt-4 text-right font-semibold tabular-nums">{fmt.inr(l.amount)}</td>
                    <td className="px-3 py-2 pt-4">
                      {rows.length > 1 && (
                        <button type="button" title="Remove this item" onClick={() => setLines(ls => ls.filter(x => x.key !== l.key))}
                          className="text-slate-400 hover:text-red-600"><Trash2 size={15} /></button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="px-4 py-3">
            <Button size="sm" variant="secondary" onClick={() => setLines(ls => [...ls, blankLine()])}><Plus size={14} /> Add item</Button>
          </div>
        </section>

        <Field label="Notes"><Input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Optional — prints nowhere, kept on the invoice" /></Field>

        {subtotal > 0 && (
          <div className="ci-summary-panel">
            <div className="flex justify-between text-slate-600"><span>Taxable value</span><b className="tabular-nums">{fmt.inr(subtotal)}</b></div>
            <div className="flex justify-between text-slate-600"><span>GST (CGST + SGST or IGST by the party's state)</span><b className="tabular-nums">{fmt.inr(tax)}</b></div>
            <div className="mt-1 flex justify-between border-t border-slate-200 pt-1 text-slate-900"><span className="font-bold">Invoice total (rounded)</span><b className="tabular-nums">{fmt.inr(Math.round(subtotal + tax))}</b></div>
            <p className="mt-1 text-xs text-slate-400">Saving takes these quantities out of stock. Deleting the invoice puts them back.</p>
          </div>
        )}
      </div>
    </Modal>
  );
}
