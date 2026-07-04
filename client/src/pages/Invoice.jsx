// Printable GST tax invoice — clean A4, browser print = PDF.
import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api, fmt } from '../api.js';
import { Button } from '../components/ui.jsx';
import { Printer, ArrowLeft } from 'lucide-react';

// Indian-system amount in words (crore/lakh), paise dropped by rounding.
const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven',
  'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
function two(n) { return n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? ' ' + ONES[n % 10] : ''}`; }
function words(n) {
  if (n === 0) return 'Zero';
  const parts = [];
  const crore = Math.floor(n / 1e7); n %= 1e7;
  const lakh = Math.floor(n / 1e5); n %= 1e5;
  const thousand = Math.floor(n / 1e3); n %= 1e3;
  const hundred = Math.floor(n / 100); n %= 100;
  if (crore) parts.push(`${words(crore)} Crore`);
  if (lakh) parts.push(`${two(lakh)} Lakh`);
  if (thousand) parts.push(`${two(thousand)} Thousand`);
  if (hundred) parts.push(`${ONES[hundred]} Hundred`);
  if (n) parts.push(two(n));
  return parts.join(' ');
}

export default function Invoice() {
  const { id } = useParams();
  const [inv, setInv] = useState(null);
  useEffect(() => { api.get(`/invoices/${id}`).then(setInv); }, [id]);
  if (!inv) return null;
  const co = inv.company;
  const intra = inv.igst === 0;

  return (
    <div className="mx-auto max-w-3xl">
      <div className="no-print mb-4 flex justify-between">
        <Link to="/invoices"><Button variant="secondary"><ArrowLeft size={14} /> Back</Button></Link>
        <Button onClick={() => window.print()}><Printer size={14} /> Print Invoice</Button>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-8 shadow-card print:border-0 print:shadow-none">
        {/* Header */}
        <div className="flex items-start justify-between border-b-2 border-ink-900 pb-4">
          <div>
            <h1 className="text-xl font-extrabold tracking-wide text-ink-900">{co.name.toUpperCase()}</h1>
            <p className="text-xs text-gray-500">Manufacturers of Printed Packaging Cartons — Pharma & FMCG</p>
            <p className="mt-1 text-xs text-gray-600">{co.address}</p>
            <p className="text-xs text-gray-600">GSTIN: <b>{co.gstin}</b> · State: {co.state} (03)</p>
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

        {/* Lines */}
        <table className="mt-6 w-full text-sm">
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
                <td className="px-3 py-2.5"><div className="font-semibold">{l.product_name}</div><div className="text-xs text-gray-400">{l.product_code} · PO {l.po_number}</div></td>
                <td className="px-3 py-2.5 text-xs text-gray-500">{l.challan_number}</td>
                <td className="px-3 py-2.5 text-xs text-gray-500">{co.hsn}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{fmt.num(l.qty)}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">₹{l.rate.toFixed(2)}</td>
                <td className="px-3 py-2.5 text-right tabular-nums text-gray-500">{l.gst_pct ?? 12}%</td>
                <td className="px-3 py-2.5 text-right font-semibold tabular-nums">{fmt.inr(l.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>

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
          Rupees {words(Math.round(inv.total))} Only
        </p>

        {inv.paid > 0 && inv.paid < inv.total && (
          <p className="mt-2 text-right text-xs text-gray-500">Received {fmt.inr(inv.paid)} · Balance <b>{fmt.inr(inv.total - inv.paid)}</b></p>
        )}

        {/* Footer */}
        <div className="mt-12 grid grid-cols-2 gap-8 text-xs text-gray-500">
          <div>
            <div className="font-bold uppercase tracking-wide text-gray-400">Terms</div>
            <p className="mt-1">Goods once sold will not be taken back. Interest @18% p.a. on overdue payments. Subject to Patiala jurisdiction.</p>
          </div>
          <div className="text-center">
            <div className="mt-8 border-t border-gray-300 pt-2">For {co.name} — Authorised Signatory</div>
          </div>
        </div>
      </div>
    </div>
  );
}
