// Printable GST tax invoice — clean A4, browser print = PDF.
import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api, fmt } from '../api.js';
import { Button, Field, Input, Modal, Textarea, useToast } from '../components/ui.jsx';
import { CoaSheet } from './COA.jsx';
import ProductIdentity from '../components/ProductIdentity.jsx';
import { rupeesInWords } from '../lib/amountWords.js';
import { Printer, ArrowLeft, FileCheck2, Save } from 'lucide-react';

export default function Invoice() {
  const { id } = useParams();
  const toast = useToast();
  const [inv, setInv] = useState(null);
  const [editing, setEditing] = useState(false);
  const [printPrompt, setPrintPrompt] = useState(false);
  const [printCoas, setPrintCoas] = useState([]);
  // 'invoice' | 'both' | 'coa' — which sheets the next window.print() should carry.
  const [printMode, setPrintMode] = useState('invoice');
  const load = () => api.get(`/invoices/${id}`).then(setInv);
  useEffect(() => { load(); }, [id]);
  if (!inv) return null;
  const co = inv.company;
  const intra = inv.igst === 0;

  const createCoa = async line => {
    const c = await api.post('/coas', { dispatch_line_id: line.dispatch_line_id, invoice_id: inv.id });
    toast.success(`${c.coa_number} ready`);
    await load();
    window.location.href = `/coas/${c.id}`;
  };

  const createAllCoas = async () => {
    const coas = [];
    for (const line of inv.lines) {
      coas.push(await api.post('/coas', { dispatch_line_id: line.dispatch_line_id, invoice_id: inv.id }));
    }
    toast.success(`${coas.length} COA${coas.length === 1 ? '' : 's'} ready for ${inv.invoice_number}`);
    await load();
  };

  // Inline line control: un-bill, push the goods back to FG, or box as leftover.
  const removeLine = async (line, action) => {
    const verb = { remove: 'remove this line from the invoice', to_fg: 'push it back to FG stock', to_leftover: 'box it as leftover' }[action];
    if (!window.confirm(`${line.product_name} — ${verb}?`)) return;
    try {
      await api.post(`/invoices/${inv.id}/lines/${line.id}/remove`, { action });
      toast.success({ remove: 'Line removed', to_fg: 'Returned to FG stock', to_leftover: 'Boxed as leftover' }[action]);
      await load();
    } catch (e) { toast.error(e.message || 'Could not update the invoice'); }
  };

  // A renumber can collide with an existing invoice; the 409 must land in front
  // of the user, not vanish into an unhandled rejection.
  const saveInvoice = async () => {
    try {
      const saved = await api.put(`/invoices/${inv.id}`, {
        invoice_number: inv.invoice_number,
        invoice_date: inv.invoice_date,
        notes: inv.notes || null,
        lines: inv.lines.map(l => ({ id: l.id, qty: +l.qty, rate: +l.rate, gst_pct: +(l.gst_pct ?? 12) })),
      });
      toast.success(`${saved.invoice_number} updated`);
      setEditing(false);
      await load();
    } catch (e) {
      // A duplicate number comes back 409 — show it and keep the dialog open so
      // the number can be corrected without retyping the rest of the edit.
      toast.error(e.message || 'Could not save the invoice');
    }
  };

  // mode: 'invoice' — the bill alone
  //       'both'    — the bill followed by a certificate per line
  //       'coa'     — the certificates alone, for a customer who already has
  //                   the bill and is chasing the paperwork behind it
  const exportInvoice = async (mode) => {
    setPrintMode(mode);
    if (mode === 'invoice') {
      setPrintCoas([]);
      setPrintPrompt(false);
      setTimeout(() => window.print(), 50);
      return;
    }
    try {
      const coas = [];
      for (const line of inv.lines) {
        coas.push(await api.post('/coas', { dispatch_line_id: line.dispatch_line_id, invoice_id: inv.id }));
      }
      setPrintCoas(coas);
      setPrintPrompt(false);
      toast.success(`${coas.length} COA${coas.length === 1 ? '' : 's'} ready for export`);
      setTimeout(() => window.print(), 100);
    } catch (e) {
      // Drafting a COA can refuse (no dispatch line, a frozen certificate).
      // Say so rather than opening a print dialog on a half-built set.
      setPrintMode('invoice');
      toast.error(e.message || 'Could not prepare the certificates');
    }
  };

  return (
    <div className="mx-auto max-w-3xl">
      <div className="no-print mb-4 flex justify-between">
        <Link to="/dispatch-invoice?tab=invoices"><Button variant="secondary"><ArrowLeft size={14} /> Back</Button></Link>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={createAllCoas}><FileCheck2 size={14} /> Create COAs</Button>
          <Button variant="secondary" onClick={() => setEditing(true)}><Save size={14} /> Edit Invoice</Button>
          <Button onClick={() => setPrintPrompt(true)}><Printer size={14} /> Export Invoice PDF</Button>
        </div>
      </div>

      <div className={`print-fit rounded-2xl border border-slate-200 bg-white p-8 shadow-card print:p-0 print:border-0 print:shadow-none${printMode === 'coa' ? ' print:hidden' : ''}`}>
        {/* Header */}
        <div className="flex items-start justify-between border-b-2 border-ink-900 pb-4">
          <div>
            <h1 className="text-xl font-extrabold tracking-wide text-ink-900">{co.name.toUpperCase()}</h1>
            <p className="text-xs text-gray-500">{co.tagline || 'Manufacturers of Printed Packaging Cartons — Pharma & FMCG'}</p>
            <p className="mt-1 text-xs text-gray-600">{co.address}</p>
            <p className="text-xs text-gray-600">GSTIN: <b>{co.gstin}</b> · State: {co.state}{co.state_code ? ` (${co.state_code})` : ''}</p>
          </div>
          <div className="text-right">
            <div className="text-sm font-extrabold text-brand-600">TAX INVOICE</div>
            <div className="mt-1 text-xs text-gray-600">No: <b>{inv.invoice_number}</b></div>
            <div className="text-xs text-gray-600">Date: <b>{fmt.date(inv.invoice_date)}</b></div>
            {inv.status === 'paid' && <div className="mt-1 inline-block rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-bold text-emerald-700">PAID</div>}
          </div>
        </div>

        {/* Buyer */}
        <div className="mt-4 grid grid-cols-2 gap-6 text-sm">
          <div>
            <div className="text-xs font-bold uppercase tracking-wide text-gray-400">Bill To</div>
            <div className="mt-1 font-bold text-gray-900">{inv.customer_name}</div>
            <div className="text-gray-600">{inv.city}{inv.state ? `, ${inv.state}` : ''}</div>
            {inv.gstin && <div className="text-xs text-gray-500">GSTIN: {inv.gstin}</div>}
          </div>
          <div className="text-right text-xs text-gray-600">
            <div className="font-bold uppercase tracking-wide text-gray-400">Place of Supply</div>
            <div className="mt-1">{inv.state || '—'} · {intra ? 'Intra-state (CGST + SGST)' : 'Inter-state (IGST)'}</div>
            <div className="mt-1">HSN: <b>{co.hsn}</b> · GST as per line items</div>
          </div>
        </div>

        {/* Lines — the sheet is fixed-width paper (max-w-3xl, p-8 → a 704px
            content box) while this table's min-content width is ~702px: eight
            columns whose numeric ones will not wrap. On any narrower window the
            table used to run straight off the right edge of the sheet, taking
            GST and Amount with it, and with nothing to scroll it was simply
            unreachable. Contained here instead; print restores the overflow so
            the PDF is byte-for-byte what it was. */}
        <div className="mt-6 overflow-x-auto print:overflow-x-visible">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-ink-900 text-left text-xs font-bold uppercase tracking-wide text-white">
              <th className="px-3 py-2">#</th><th className="px-3 py-2">Description</th>
              <th className="px-3 py-2">Challan</th><th className="px-3 py-2">HSN</th>
              <th className="px-3 py-2 text-right">Qty</th><th className="px-3 py-2 text-right">Rate</th>
              <th className="px-3 py-2 text-right">GST</th>
              <th className="px-3 py-2 text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {inv.lines.map((l, i) => (
              <tr key={l.id} className="border-b border-gray-100">
                <td className="px-3 py-2.5 text-gray-500">{i + 1}</td>
                <td className="px-3 py-2.5">
                  <ProductIdentity row={l}
                    meta={`PO ${l.po_number}${l.pack_boxes ? ` · ${fmt.num(l.pack_boxes)} boxes${l.pack_qty_per_box ? ` x ${fmt.num(l.pack_qty_per_box)}` : ''}` : ''}`} />
                  <div className="no-print mt-1">
                    {l.coa_id ? (
                      <Link to={`/coas/${l.coa_id}`} className="inline-flex items-center gap-1 text-[11px] font-bold text-brand-600 hover:underline">
                        <FileCheck2 size={12} /> {l.coa_number}
                      </Link>
                    ) : (
                      <button onClick={() => createCoa(l)} className="inline-flex items-center gap-1 text-[11px] font-bold text-slate-500 hover:text-brand-600">
                        <FileCheck2 size={12} /> Create COA
                      </button>
                    )}
                  </div>
                </td>
                <td className="px-3 py-2.5 text-xs text-gray-500">{l.challan_number}</td>
                <td className="px-3 py-2.5 text-xs text-gray-500">{co.hsn}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{fmt.num(l.qty)}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">₹{Number(l.rate || 0).toFixed(2)}</td>
                <td className="px-3 py-2.5 text-right tabular-nums text-gray-500">{l.gst_pct ?? 12}%</td>
                <td className="px-3 py-2.5 text-right font-semibold tabular-nums">{fmt.inr(l.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>

        {/* Totals */}
        <div className="mt-4 flex justify-end">
          <div className="w-72 space-y-1 text-sm">
            <div className="flex justify-between text-gray-600"><span>Taxable Value</span><span className="tabular-nums">{fmt.inr(inv.subtotal)}</span></div>
            {intra ? (<>
              <div className="flex justify-between text-gray-600"><span>CGST</span><span className="tabular-nums">{fmt.inr(inv.cgst)}</span></div>
              <div className="flex justify-between text-gray-600"><span>SGST</span><span className="tabular-nums">{fmt.inr(inv.sgst)}</span></div>
            </>) : (
              <div className="flex justify-between text-gray-600"><span>IGST</span><span className="tabular-nums">{fmt.inr(inv.igst)}</span></div>
            )}
            <div className="flex justify-between text-gray-500 text-xs"><span>Round off</span><span className="tabular-nums">{inv.round_off >= 0 ? '+' : ''}{inv.round_off.toFixed(2)}</span></div>
            <div className="flex justify-between border-t-2 border-ink-900 pt-1.5 text-base font-extrabold text-ink-900">
              <span>Grand Total</span><span className="tabular-nums">{fmt.inr(inv.total)}</span>
            </div>
          </div>
        </div>
        <p className="mt-2 text-right text-xs italic text-gray-500">
          {rupeesInWords(inv.total)}
        </p>

        {inv.paid > 0 && inv.paid < inv.total && (
          <p className="mt-2 text-right text-xs text-gray-500">Received {fmt.inr(inv.paid)} · Balance <b>{fmt.inr(inv.total - inv.paid)}</b></p>
        )}

        {/* Footer */}
        <div className="mt-12 grid grid-cols-2 gap-8 text-xs text-gray-500 print:mt-8">
          <div>
            <div className="font-bold uppercase tracking-wide text-gray-400">Terms</div>
            <p className="mt-1">Goods once sold will not be taken back. Interest @18% p.a. on overdue payments. Subject to {co.jurisdiction || 'Patiala'} jurisdiction.</p>
          </div>
          <div className="text-center">
            <div className="mt-8 border-t border-gray-300 pt-2">For {co.name} — Authorised Signatory</div>
          </div>
        </div>
      </div>

      {printCoas.map((c, i) => (
        <CoaSheet key={c.id} coa={c} leadPage={printMode === 'coa' && i === 0} />
      ))}

      <Modal open={printPrompt} onClose={() => setPrintPrompt(false)} title="Export invoice PDF"
        footer={<>
          <Button variant="secondary" onClick={() => exportInvoice('invoice')}>Invoice Only</Button>
          <Button variant="secondary" onClick={() => exportInvoice('coa')}><FileCheck2 size={14} /> COA Only</Button>
          <Button onClick={() => exportInvoice('both')}><FileCheck2 size={14} /> Invoice + COA</Button>
        </>}>
        <p className="text-sm text-slate-600">
          What should this export carry? <b>COA Only</b> prints the certificates without the
          bill — for a customer who already has the invoice and is chasing the paperwork behind
          it. Missing COAs are drafted automatically from the dispatch and release data.
        </p>
      </Modal>

      <Modal wide open={editing} onClose={() => setEditing(false)} title={`Edit ${inv.invoice_number}`}
        footer={<>
          <Button variant="secondary" onClick={() => setEditing(false)}>Cancel</Button>
          <Button onClick={saveInvoice}>Save Invoice</Button>
        </>}>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Invoice No" hint="Editable — must stay unique. The change is audited under both numbers.">
              <Input value={inv.invoice_number || ''} onChange={e => setInv({ ...inv, invoice_number: e.target.value })} />
            </Field>
            <Field label="Invoice Date"><Input type="date" value={String(inv.invoice_date || '').slice(0, 10)} onChange={e => setInv({ ...inv, invoice_date: e.target.value })} /></Field>
            <Field label="Notes"><Textarea value={inv.notes || ''} onChange={e => setInv({ ...inv, notes: e.target.value })} /></Field>
          </div>
          <table className="w-full text-sm">
            <thead><tr className="ci-table-head"><th className="px-3 py-2">Item</th><th className="px-3 py-2 text-right">Qty</th><th className="px-3 py-2 text-right">Rate</th><th className="px-3 py-2 text-right">GST %</th><th className="px-3 py-2 text-right">Line action</th></tr></thead>
            <tbody>
              {inv.lines.map(l => (
                <tr key={l.id} className="border-b border-slate-100">
                  <td className="px-3 py-2">
                    <ProductIdentity row={l}
                      meta={`${l.challan_number}${l.pack_boxes ? ` · ${fmt.num(l.pack_boxes)} boxes` : ''}`} />
                  </td>
                  <td className="px-3 py-2"><Input className="text-right" type="number" min="1" value={l.qty} onChange={e => setInv({ ...inv, lines: inv.lines.map(x => x.id === l.id ? { ...x, qty: e.target.value } : x) })} /></td>
                  <td className="px-3 py-2"><Input className="text-right" type="number" min="0" value={l.rate} onChange={e => setInv({ ...inv, lines: inv.lines.map(x => x.id === l.id ? { ...x, rate: e.target.value } : x) })} /></td>
                  <td className="px-3 py-2"><Input className="text-right" type="number" min="0" value={l.gst_pct ?? 12} onChange={e => setInv({ ...inv, lines: inv.lines.map(x => x.id === l.id ? { ...x, gst_pct: e.target.value } : x) })} /></td>
                  <td className="px-3 py-2">
                    <div className="flex justify-end gap-1">
                      <Button size="sm" variant="secondary" title="Remove from invoice only" onClick={() => removeLine(l, 'remove')}>Remove</Button>
                      <Button size="sm" variant="secondary" title="Push the goods back to FG stock" onClick={() => removeLine(l, 'to_fg')}>→ FG</Button>
                      <Button size="sm" variant="secondary" title="Return to FG and box as a leftover box" onClick={() => removeLine(l, 'to_leftover')}>→ Leftover</Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-slate-400">Remove = un-bill only. → FG returns the goods to Finished Goods stock and drops the challan line. → Leftover also boxes them (auto CI-BOX-####). Blocked once a payment is recorded.</p>
        </div>
      </Modal>
    </div>
  );
}
