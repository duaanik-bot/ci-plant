// Printable delivery challan — clean A4, browser print = PDF.
import { useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { api, fmt } from '../api.js';
import { Button, Field, Input, Modal, Textarea, useToast } from '../components/ui.jsx';
import ProductIdentity from '../components/ProductIdentity.jsx';
import { Printer, ArrowLeft, FileCheck2, Save, Undo2 } from 'lucide-react';

export default function Challan() {
  const { id } = useParams();
  const toast = useToast();
  const nav = useNavigate();
  const [d, setD] = useState(null);
  const [editing, setEditing] = useState(false);
  const load = () => api.get(`/dispatches/${id}`).then(setD);
  useEffect(() => { load(); }, [id]);
  if (!d) return null;

  // Cancel the whole challan — every line goes back to FG stock.
  const cancelChallan = async () => {
    if (!window.confirm(`Cancel challan ${d.challan_number}? All its goods go back to FG stock and the challan is removed.`)) return;
    try {
      await api.post(`/dispatches/${d.id}/cancel`, {});
      toast.success(`${d.challan_number} cancelled — goods returned to FG`);
      nav('/dispatch-invoice?tab=register');
    } catch (e) { toast.error(e.message || 'Could not cancel the challan'); }
  };

  const save = async () => {
    await api.put(`/dispatches/${d.id}`, {
      vehicle: d.vehicle || null,
      driver: d.driver || null,
      notes: d.notes || null,
      lines: d.lines.map(l => ({ dispatch_line_id: l.id, qty: +l.qty })),
    });
    toast.success(`${d.challan_number} updated`);
    setEditing(false);
    await load();
  };

  const createCoa = async line => {
    const c = await api.post('/coas', { dispatch_line_id: line.id });
    toast.success(`${c.coa_number} ready`);
    await load();
    window.location.href = `/coas/${c.id}`;
  };

  return (
    <div className="mx-auto max-w-3xl">
      <div className="no-print mb-4 flex justify-between">
        <Link to="/dispatch-invoice?tab=register"><Button variant="secondary"><ArrowLeft size={14} /> Back</Button></Link>
        <div className="flex flex-wrap gap-2">
          <Button variant="ghost" onClick={cancelChallan}><Undo2 size={14} /> Cancel Challan</Button>
          <Button variant="secondary" onClick={() => setEditing(true)}><Save size={14} /> Edit Challan</Button>
          <Button onClick={() => window.print()}><Printer size={14} /> Print Challan</Button>
        </div>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-8 shadow-card print:border-0 print:shadow-none">
        {/* Header */}
        <div className="flex items-start justify-between border-b-2 border-ink-900 pb-4">
          <div>
            <h1 className="text-xl font-extrabold tracking-wide text-ink-900">COLOUR IMPRESSIONS</h1>
            <p className="text-xs text-gray-500">Manufacturers of Printed Packaging Cartons — Pharma & FMCG</p>
          </div>
          <div className="text-right">
            <div className="text-sm font-extrabold text-brand-600">DELIVERY CHALLAN</div>
            <div className="mt-1 text-xs text-gray-600">No: <b>{d.challan_number}</b></div>
            <div className="text-xs text-gray-600">Date: <b>{fmt.date(d.dispatched_at)}</b></div>
          </div>
        </div>

        {/* Parties */}
        <div className="mt-4 grid grid-cols-2 gap-6 text-sm">
          <div>
            <div className="text-xs font-bold uppercase tracking-wide text-gray-400">Consignee</div>
            <div className="mt-1 font-bold text-gray-900">{d.customer_name}</div>
            <div className="text-gray-600">{d.city}{d.state ? `, ${d.state}` : ''}</div>
            {d.gstin && <div className="text-xs text-gray-500">GSTIN: {d.gstin}</div>}
          </div>
          <div className="text-right">
            <div className="text-xs font-bold uppercase tracking-wide text-gray-400">Reference</div>
            <div className="mt-1 text-gray-700">Against PO: <b>{d.po_number}</b> ({fmt.date(d.po_date)})</div>
            {d.vehicle && <div className="text-gray-700">Vehicle: <b>{d.vehicle}</b></div>}
            {d.driver && <div className="text-gray-700">Driver: {d.driver}</div>}
          </div>
        </div>

        {/* Lines */}
        <table className="mt-6 w-full text-sm">
          <thead>
            <tr className="bg-ink-900 text-left text-xs font-bold uppercase tracking-wide text-white">
              <th className="px-3 py-2">#</th><th className="px-3 py-2">Product</th>
              <th className="px-3 py-2">Code</th><th className="px-3 py-2">Size</th>
              <th className="px-3 py-2 text-right">Boxes</th>
              <th className="px-3 py-2 text-right">Quantity (Cartons)</th>
            </tr>
          </thead>
          <tbody>
            {d.lines.map((l, i) => (
              <tr key={l.id} className="border-b border-gray-100">
                <td className="px-3 py-2.5 text-gray-500">{i + 1}</td>
                <td className="px-3 py-2.5">
                  <ProductIdentity row={l} />
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
                <td className="px-3 py-2.5 text-gray-500">{l.code}</td>
                <td className="px-3 py-2.5 text-gray-500">{l.size}</td>
                <td className="px-3 py-2.5 text-right tabular-nums text-gray-600">
                  {l.pack_boxes ? <>{fmt.num(l.pack_boxes)}<span className="text-gray-400">{l.pack_qty_per_box ? ` × ${fmt.num(l.pack_qty_per_box)}` : ''}</span></> : <span className="text-gray-300">—</span>}
                </td>
                <td className="px-3 py-2.5 text-right font-bold tabular-nums">{fmt.num(l.qty)}</td>
              </tr>
            ))}
            <tr className="bg-gray-50 font-extrabold">
              <td colSpan={4} className="px-3 py-2.5 text-right text-xs uppercase tracking-wide">Total</td>
              <td className="px-3 py-2.5 text-right tabular-nums text-gray-600">{fmt.num(d.lines.reduce((s, l) => s + (l.pack_boxes || 0), 0))}</td>
              <td className="px-3 py-2.5 text-right tabular-nums">{fmt.num(d.lines.reduce((s, l) => s + l.qty, 0))}</td>
            </tr>
          </tbody>
        </table>

        {d.notes && <p className="mt-4 text-xs text-gray-500">Note: {d.notes}</p>}

        {/* Signatures */}
        <div className="mt-14 grid grid-cols-3 gap-8 text-center text-xs text-gray-500">
          <div className="border-t border-gray-300 pt-2">Prepared By</div>
          <div className="border-t border-gray-300 pt-2">Checked By</div>
          <div className="border-t border-gray-300 pt-2">Receiver's Signature</div>
        </div>
        <p className="mt-6 text-center text-[10px] text-gray-400">
          This is a delivery challan, not an invoice. Goods remain the property of Colour Impressions until invoiced.
        </p>
      </div>

      <Modal wide open={editing} onClose={() => setEditing(false)} title={`Edit ${d.challan_number}`}
        footer={<>
          <Button variant="secondary" onClick={() => setEditing(false)}>Cancel</Button>
          <Button onClick={save}>Save Challan</Button>
        </>}>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Vehicle No"><Input value={d.vehicle || ''} onChange={e => setD({ ...d, vehicle: e.target.value })} /></Field>
            <Field label="Driver"><Input value={d.driver || ''} onChange={e => setD({ ...d, driver: e.target.value })} /></Field>
          </div>
          <Field label="Notes"><Textarea value={d.notes || ''} onChange={e => setD({ ...d, notes: e.target.value })} /></Field>
          <table className="w-full text-sm">
            <thead><tr className="ci-table-head"><th className="px-3 py-2">Product</th><th className="px-3 py-2 text-right">Ordered</th><th className="px-3 py-2 text-right">FG Stock</th><th className="px-3 py-2 text-right">Challan Qty</th></tr></thead>
            <tbody>
              {d.lines.map(l => (
                <tr key={l.id} className="border-b border-slate-100">
                  <td className="px-3 py-2"><ProductIdentity row={l} compact /></td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmt.num(l.ordered_qty)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmt.num(l.fg_qty)}</td>
                  <td className="px-3 py-2">
                    <Input className="text-right" type="number" min="0" value={l.qty}
                      disabled={!!l.invoice_id}
                      onChange={e => setD({ ...d, lines: d.lines.map(x => x.id === l.id ? { ...x, qty: e.target.value } : x) })} />
                    {l.invoice_id && <div className="mt-1 text-[10px] font-semibold text-slate-400">Billed on {l.invoice_number}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Modal>
    </div>
  );
}
