// Printable vendor purchase order — clean A4, browser print = PDF.
import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api, fmt } from '../api.js';
import { Button } from '../components/ui.jsx';
import { Printer, ArrowLeft } from 'lucide-react';

export default function POPrint() {
  const { id } = useParams();
  const [po, setPo] = useState(null);
  useEffect(() => { api.get(`/purchase-orders/${id}`).then(setPo); }, [id]);
  if (!po) return null;
  const total = po.lines.reduce((s, l) => s + l.qty * l.rate, 0);

  return (
    <div className="mx-auto max-w-3xl">
      <div className="no-print mb-4 flex justify-between">
        <Link to="/procurement"><Button variant="secondary"><ArrowLeft size={14} /> Back</Button></Link>
        <Button onClick={() => window.print()}><Printer size={14} /> Print PO</Button>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-8 shadow-card print:border-0 print:shadow-none">
        <div className="flex items-start justify-between border-b-2 border-ink-900 pb-4">
          <div>
            <h1 className="text-xl font-extrabold tracking-wide text-ink-900">COLOUR IMPRESSIONS</h1>
            <p className="text-xs text-gray-500">Manufacturers of Printed Packaging Cartons — Pharma & FMCG</p>
            <p className="mt-1 text-xs text-gray-600">Focal Point, Patiala, Punjab 147004 · GSTIN: 03AABCC1234D1Z5</p>
          </div>
          <div className="text-right">
            <div className="text-sm font-extrabold text-brand-600">PURCHASE ORDER</div>
            <div className="mt-1 text-xs text-gray-600">No: <b>{po.po_number}</b></div>
            <div className="text-xs text-gray-600">Date: <b>{fmt.date(po.created_at)}</b></div>
            {po.pr_number && <div className="text-xs text-gray-500">Against {po.pr_number}</div>}
          </div>
        </div>

        <div className="mt-4 text-sm">
          <div className="text-xs font-bold uppercase tracking-wide text-gray-400">To</div>
          <div className="mt-1 font-bold text-gray-900">{po.vendor_name}</div>
          <div className="text-gray-600">{po.vendor_city}</div>
          {po.vendor_contact && <div className="text-xs text-gray-500">Attn: {po.vendor_contact}{po.vendor_phone ? ` · ${po.vendor_phone}` : ''}</div>}
        </div>

        <table className="mt-6 w-full text-sm">
          <thead>
            <tr className="bg-ink-900 text-left text-xs font-bold uppercase tracking-wide text-white">
              <th className="px-3 py-2">#</th><th className="px-3 py-2">Material</th>
              <th className="px-3 py-2">Specification</th>
              <th className="px-3 py-2 text-right">Qty</th><th className="px-3 py-2 text-right">Rate</th>
              <th className="px-3 py-2 text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {po.lines.map((l, i) => (
              <tr key={l.id} className="border-b border-gray-100">
                <td className="px-3 py-2.5 text-gray-500">{i + 1}</td>
                <td className="px-3 py-2.5 font-semibold">{l.material_name}</td>
                <td className="px-3 py-2.5 text-xs text-gray-500">{l.spec || '—'}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{fmt.num(l.qty)} {l.unit}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">₹{l.rate}</td>
                <td className="px-3 py-2.5 text-right font-semibold tabular-nums">{fmt.inr(l.qty * l.rate)}</td>
              </tr>
            ))}
            <tr className="bg-gray-50 font-extrabold">
              <td colSpan={5} className="px-3 py-2.5 text-right text-xs uppercase tracking-wide">Total (excl. GST)</td>
              <td className="px-3 py-2.5 text-right tabular-nums">{fmt.inr(total)}</td>
            </tr>
          </tbody>
        </table>

        <div className="mt-6 text-xs text-gray-500">
          <div className="font-bold uppercase tracking-wide text-gray-400">Terms</div>
          <p className="mt-1">Deliver to works at Focal Point, Patiala with batch-wise packing list. Material subject to incoming QC — rejections returned at supplier's cost. GST extra as applicable.</p>
        </div>

        <div className="mt-12 grid grid-cols-2 gap-8 text-center text-xs text-gray-500">
          <div className="border-t border-gray-300 pt-2">Prepared By</div>
          <div className="border-t border-gray-300 pt-2">For Colour Impressions — Authorised Signatory</div>
        </div>
      </div>
    </div>
  );
}
