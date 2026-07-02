// Printable delivery challan — clean A4, browser print = PDF.
import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api, fmt } from '../api.js';
import { Button } from '../components/ui.jsx';
import { Printer, ArrowLeft } from 'lucide-react';

export default function Challan() {
  const { id } = useParams();
  const [d, setD] = useState(null);
  useEffect(() => { api.get(`/dispatches/${id}`).then(setD); }, [id]);
  if (!d) return null;

  return (
    <div className="mx-auto max-w-3xl">
      <div className="no-print mb-4 flex justify-between">
        <Link to="/dispatch"><Button variant="secondary"><ArrowLeft size={14} /> Back</Button></Link>
        <Button onClick={() => window.print()}><Printer size={14} /> Print Challan</Button>
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
              <th className="px-3 py-2 text-right">Quantity (Cartons)</th>
            </tr>
          </thead>
          <tbody>
            {d.lines.map((l, i) => (
              <tr key={l.id} className="border-b border-gray-100">
                <td className="px-3 py-2.5 text-gray-500">{i + 1}</td>
                <td className="px-3 py-2.5 font-semibold">{l.product_name}</td>
                <td className="px-3 py-2.5 text-gray-500">{l.code}</td>
                <td className="px-3 py-2.5 text-gray-500">{l.size}</td>
                <td className="px-3 py-2.5 text-right font-bold tabular-nums">{fmt.num(l.qty)}</td>
              </tr>
            ))}
            <tr className="bg-gray-50 font-extrabold">
              <td colSpan={4} className="px-3 py-2.5 text-right text-xs uppercase tracking-wide">Total</td>
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
    </div>
  );
}
