// Printable vendor purchase order — GST tax-style layout, clean A4, print = PDF.
import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api, fmt } from '../api.js';
import { Button, ExportMenu } from '../components/ui.jsx';
import { lineTaxable, lineAmount, poTotals } from '../lib/poTotals.js';
import { rupeesInWords } from '../lib/amountWords.js';
import { kgPerSheet, packets, totalWeight, packetRate, ratePerKgFromSheet } from '../lib/boardMath.js';
import { Printer, ArrowLeft } from 'lucide-react';

// Compact number formatters for board weight columns.
const fmtKg = n => (n == null ? '' : n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const fmtPkt = n => (n == null ? '' : n.toLocaleString('en-IN', { maximumFractionDigits: 1 }));
const isBoard = l => !!(l.grade && +l.gsm > 0);

// fmt.inr rounds to whole rupees, which is right for a line amount and wrong for
// a rate: a ₹81.50/kg board must not print as ₹82/kg. Rates get their own 2dp
// formatter; totals keep fmt.inr.
const fmtRate = n => (n == null ? '' : '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

// The vendor's copy is filed by PO number and supplier, so that is what the file
// is called — for the browser's print-to-PDF (which takes document.title) and
// for the Export menu alike. No date stamp: a PO number is already unique, and a
// second download must overwrite the first rather than sit beside it.
const poFileName = po => `${po.po_number} ${po.vendor_name || ''}`.trim();

function Field({ label, value }) {
  if (!value) return null;
  return (
    <div>
      <div className="text-[10px] font-bold uppercase tracking-wide text-gray-400">{label}</div>
      <div className="text-xs text-gray-800">{value}</div>
    </div>
  );
}

const STATUS_LABEL = {
  open: 'Open', partially_received: 'Partially Received', received: 'Received', closed: 'Closed',
};

export default function POPrint() {
  const { id } = useParams();
  const [po, setPo] = useState(null);
  useEffect(() => { api.get(`/purchase-orders/${id}`).then(setPo); }, [id]);

  // Chrome/Safari seed the print-to-PDF filename from document.title, so the
  // title IS the filename here. Restored on unmount — leaving it set would
  // rename every other page's print for the rest of the session.
  useEffect(() => {
    if (!po) return;
    const prev = document.title;
    document.title = poFileName(po);
    return () => { document.title = prev; };
  }, [po]);

  if (!po) return null;

  const co = po.company || {};
  const coName = co.name || 'Colour Impressions';
  const coAddr = [co.address, co.city, co.state].filter(Boolean).join(', ');
  const t = poTotals(po.lines, { freight: po.freight, taxKind: po.tax_kind, round_off: po.round_off });
  const totalQty = po.lines.reduce((s, l) => s + (+l.qty || 0), 0);
  const intra = t.taxKind === 'intra';

  // Board-weight roll-up across board lines only (sheets · packets · kg).
  const boardTot = po.lines.reduce((a, l) => {
    if (!isBoard(l)) return a;
    const kg = totalWeight(l, l.qty), pk = packets(l, l.qty);
    a.any = true;
    a.sheets += +l.qty || 0;
    if (kg != null) a.kg += kg;
    if (pk != null) a.packets += pk;
    return a;
  }, { any: false, sheets: 0, packets: 0, kg: 0 });

  return (
    <div className="mx-auto max-w-4xl">
      <div className="no-print mb-4 flex justify-between">
        <Link to="/procurement"><Button variant="secondary"><ArrowLeft size={14} /> Back</Button></Link>
        <div className="flex items-center gap-2">
          {/* The exported sheet carries the same stack as the paper copy — a
              buyer who exports to check a rate must not meet a different set of
              columns than the one they just signed. */}
          <ExportMenu build={() => ({
            fileName: poFileName(po),
            title: `Purchase Order ${po.po_number}`,
            subtitle: `${po.vendor_name}${po.expected_date ? ` · expected ${fmt.date(po.expected_date)}` : ''}`,
            meta: [
              intra ? 'CGST + SGST · Intra-state' : 'IGST · Inter-state',
              po.status ? STATUS_LABEL[po.status] || po.status : null,
              po.pr_number ? `Against ${po.pr_number}` : null,
            ],
            summary: [
              { label: 'Lines', value: po.lines.length },
              ...(boardTot.any ? [
                { label: 'Packets', value: fmtPkt(boardTot.packets) },
                { label: 'Sheets', value: fmt.num(boardTot.sheets) },
                { label: 'Weight', value: `${fmtKg(boardTot.kg)} kg` },
              ] : []),
              { label: 'Grand Total', value: fmt.inr(t.grand) },
            ],
            columns: [
              { key: 'material_name', label: 'Material' },
              { key: 'hsn_code', label: 'HSN', export: l => l.hsn_code || '—' },
              { key: 'packets', label: 'Packets', align: 'right', export: l => (isBoard(l) ? fmtPkt(packets(l, l.qty)) : '—') },
              { key: 'qty', label: 'Sheets', align: 'right', export: l => `${fmt.num(l.qty)} ${l.unit || ''}`.trim() },
              { key: 'weight', label: 'Weight kg', align: 'right', export: l => (isBoard(l) ? fmtKg(totalWeight(l, l.qty)) : '—') },
              { key: 'rate_kg', label: 'Rate/kg', align: 'right', export: l => {
                const r = isBoard(l) ? ratePerKgFromSheet(l, l.rate) : null;
                return r == null ? '—' : fmtRate(r);
              } },
              { key: 'rate_pkt', label: 'Rate/packet', align: 'right', export: l => {
                const r = isBoard(l) ? ratePerKgFromSheet(l, l.rate) : null;
                const p = r == null ? null : packetRate(l, r);
                return p == null ? fmtRate(+l.rate || 0) : fmtRate(p);
              } },
              { key: 'discount_pct', label: 'Disc%', align: 'right', export: l => (+l.discount_pct ? `${l.discount_pct}%` : '—') },
              { key: 'taxable', label: 'Taxable', align: 'right', export: l => fmt.inr(lineTaxable(l)) },
              { key: 'gst_rate', label: 'GST%', align: 'right', export: l => `${+l.gst_rate || 0}%` },
              { key: 'amount', label: 'Amount', align: 'right', export: l => fmt.inr(lineAmount(l)) },
            ],
            rows: po.lines,
          })} />
          <Button onClick={() => window.print()}><Printer size={14} /> Print PO</Button>
        </div>
      </div>

      <div className="print-fit rounded-2xl border border-slate-200 bg-white p-8 shadow-card print:p-0 print:border-0 print:shadow-none">
        {/* Header */}
        <div className="flex items-start justify-between border-b-2 border-ink-900 pb-4">
          <div>
            <h1 className="text-xl font-extrabold tracking-wide text-ink-900">{coName.toUpperCase()}</h1>
            <p className="text-xs text-gray-500">Manufacturers of Printed Packaging Cartons — Pharma &amp; FMCG</p>
            {coAddr && <p className="mt-1 text-xs text-gray-600">{coAddr}{co.gstin ? ` · GSTIN: ${co.gstin}` : ''}</p>}
          </div>
          <div className="text-right">
            <div className="text-sm font-extrabold text-brand-600">PURCHASE ORDER</div>
            <div className="mt-1 text-xs text-gray-600">No: <b>{po.po_number}</b></div>
            <div className="text-xs text-gray-600">Date: <b>{fmt.date(po.created_at)}</b></div>
            <div className="mt-0.5 text-[10px] font-bold uppercase tracking-wide text-gray-400">
              {intra ? 'CGST + SGST · Intra-state' : 'IGST · Inter-state'}{po.status ? ` · ${STATUS_LABEL[po.status] || po.status}` : ''}
            </div>
          </div>
        </div>

        {/* Supplier + Deliver-to */}
        <div className="mt-4 grid grid-cols-2 gap-4">
          <div className="rounded-lg border border-gray-200 p-3">
            <div className="text-[10px] font-bold uppercase tracking-wide text-gray-400">Supplier</div>
            <div className="mt-1 font-bold text-gray-900">{po.vendor_name}</div>
            {po.vendor_address && <div className="text-xs text-gray-600">{po.vendor_address}</div>}
            {(po.vendor_city || po.vendor_state) && <div className="text-xs text-gray-600">{[po.vendor_city, po.vendor_state].filter(Boolean).join(', ')}</div>}
            {po.vendor_gstin && <div className="mt-0.5 text-xs text-gray-500">GSTIN: {po.vendor_gstin}{po.vendor_state_code ? ` · State code ${po.vendor_state_code}` : ''}</div>}
            {po.vendor_contact && po.vendor_contact !== po.vendor_name && <div className="mt-0.5 text-xs text-gray-500">Attn: {po.vendor_contact}</div>}
            {po.vendor_phone && <div className="text-xs text-gray-500">Ph: {po.vendor_phone}</div>}
          </div>
          <div className="rounded-lg border border-gray-200 p-3">
            <div className="text-[10px] font-bold uppercase tracking-wide text-gray-400">Deliver / Bill To</div>
            <div className="mt-1 font-bold text-gray-900">{coName} — Works</div>
            {coAddr && <div className="text-xs text-gray-600">{coAddr}</div>}
            {co.gstin && <div className="mt-0.5 text-xs text-gray-500">GSTIN: {co.gstin}{co.state_code ? ` · State code ${co.state_code}` : ''}</div>}
          </div>
        </div>

        {/* Order meta */}
        <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 rounded-lg bg-gray-50 px-4 py-3 sm:grid-cols-4">
          <Field label="Expected Delivery" value={po.expected_date ? fmt.date(po.expected_date) : 'As agreed'} />
          <Field label="Against Requisition" value={po.pr_number} />
          <Field label="Vendor Reference" value={po.reference} />
          <Field label="Prepared By" value={po.created_by} />
        </div>

        {/* Line items */}
        <div className="mt-6 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-ink-900 text-left text-[11px] font-bold uppercase tracking-wide text-white">
                <th className="px-2 py-2">#</th><th className="px-2 py-2">Material</th>
                <th className="px-2 py-2">HSN</th>
                <th className="px-2 py-2 text-right">Qty</th><th className="px-2 py-2 text-right">Rate</th>
                <th className="px-2 py-2 text-right">Disc%</th><th className="px-2 py-2 text-right">Taxable</th>
                <th className="px-2 py-2 text-right">GST%</th><th className="px-2 py-2 text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {po.lines.map((l, i) => {
                const board = isBoard(l);
                const kg = board ? totalWeight(l, l.qty) : null;
                const kps = board ? kgPerSheet(l) : null;
                const pk = board ? packets(l, l.qty) : null;
                // Board is bought by weight: ₹/kg leads, ₹/packet is the figure
                // the vendor bills back. Both are inverted from the line's stored
                // ₹/sheet, so a PO raised before this change prints them too.
                const rpk = board ? ratePerKgFromSheet(l, l.rate) : null;
                const pRate = rpk != null ? packetRate(l, rpk) : null;
                const spec = board
                  ? [l.grade, +l.gsm > 0 ? `${l.gsm} GSM` : null,
                     (+l.sheet_l > 0 && +l.sheet_w > 0) ? `${l.sheet_l} × ${l.sheet_w}"` : null,
                     +l.sheets_per_packet > 0 ? `${l.sheets_per_packet} sheets/packet` : null,
                    ].filter(Boolean).join(' · ')
                  : (l.spec || '');
                return (
                <tr key={l.id} className="border-b border-gray-100 align-top">
                  <td className="px-2 py-2 text-gray-500">{i + 1}</td>
                  <td className="px-2 py-2 font-semibold">{l.material_name}{spec ? <span className="block text-[10px] font-normal text-gray-400">{spec}</span> : null}</td>
                  <td className="px-2 py-2 text-xs text-gray-500">{l.hsn_code || '—'}</td>
                  {/* Packets lead, sheets underneath, weight in brackets — the
                      order the stores counts a delivery in. A non-board line has
                      no packet or weight, so it just states its own unit. */}
                  <td className="px-2 py-2 text-right tabular-nums">
                    {pk != null ? <>
                      <div className="font-semibold">{fmtPkt(pk)} pkt</div>
                      <div className="text-[10px] font-normal text-gray-500">{fmt.num(l.qty)} {l.unit}</div>
                      {kg != null && <div className="text-[10px] font-normal text-gray-400">({fmtKg(kg)} kg)</div>}
                    </> : <>
                      <div className="font-semibold">{fmt.num(l.qty)} {l.unit}</div>
                      {kg != null && <div className="text-[10px] font-normal text-gray-400">({fmtKg(kg)} kg)</div>}
                    </>}
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums">
                    {rpk != null ? <>
                      <div className="font-semibold">{fmtRate(rpk)}/kg</div>
                      {pRate != null && <div className="text-[10px] font-normal text-gray-500">{fmtRate(pRate)}/pkt</div>}
                    </> : fmtRate(+l.rate || 0)}
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums">{+l.discount_pct ? `${l.discount_pct}%` : '—'}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{fmt.inr(lineTaxable(l))}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{+l.gst_rate || 0}%</td>
                  <td className="px-2 py-2 text-right font-semibold tabular-nums">{fmt.inr(lineAmount(l))}</td>
                </tr>
                );
              })}
              <tr className="border-b border-gray-100 text-xs text-gray-500">
                <td className="px-2 py-1.5" colSpan={3}>{po.lines.length} line item{po.lines.length === 1 ? '' : 's'}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">
                  {boardTot.any && <div><b className="text-gray-700">{fmtPkt(boardTot.packets)}</b> pkt</div>}
                  <div className="text-[10px]">{fmt.num(totalQty)}</div>
                </td>
                {boardTot.any
                  ? <td className="px-2 py-1.5 text-right tabular-nums" colSpan={5}>
                      Boards: <b className="text-gray-700">{fmt.num(boardTot.sheets)}</b> sheets · <b className="text-gray-700">{fmtPkt(boardTot.packets)}</b> packets · <b className="text-gray-700">{fmtKg(boardTot.kg)} kg</b>
                    </td>
                  : <td colSpan={5}></td>}
              </tr>
            </tbody>
          </table>
        </div>

        {/* Tax summary + totals */}
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            {t.byRate.length > 0 && (
              <table className="w-full text-xs">
                <thead><tr className="border-b border-gray-200 text-left text-gray-400">
                  <th className="py-1">GST%</th><th className="py-1 text-right">Taxable</th>
                  {intra ? <><th className="py-1 text-right">CGST</th><th className="py-1 text-right">SGST</th></> : <th className="py-1 text-right">IGST</th>}
                </tr></thead>
                <tbody>
                  {t.byRate.map(b => (
                    <tr key={b.rate} className="border-b border-gray-50">
                      <td className="py-1">{b.rate}%</td>
                      <td className="py-1 text-right tabular-nums">{fmt.inr(b.taxable)}</td>
                      {intra ? <>
                        <td className="py-1 text-right tabular-nums">{fmt.inr(b.tax / 2)}</td>
                        <td className="py-1 text-right tabular-nums">{fmt.inr(b.tax / 2)}</td>
                      </> : <td className="py-1 text-right tabular-nums">{fmt.inr(b.tax)}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <div className="text-sm">
            <Row label="Taxable Value" value={fmt.inr(t.taxable)} />
            {t.discount > 0 && <Row label="Total Discount" value={`− ${fmt.inr(t.discount)}`} />}
            {intra ? <>
              <Row label="CGST" value={fmt.inr(t.cgst)} />
              <Row label="SGST" value={fmt.inr(t.sgst)} />
            </> : <Row label="IGST" value={fmt.inr(t.igst)} />}
            {t.freight > 0 && <Row label="Freight / Other" value={fmt.inr(t.freight)} />}
            {t.round_off !== 0 && <Row label="Round Off" value={fmt.inr(t.round_off)} />}
            <div className="mt-1 border-t-2 border-ink-900 pt-2">
              <Row label="Grand Total" value={fmt.inr(t.grand)} strong />
            </div>
          </div>
        </div>

        {/* Amount in words */}
        <div className="mt-2 rounded-lg border border-gray-200 px-4 py-2 text-xs">
          <span className="font-bold uppercase tracking-wide text-gray-400">Amount in words: </span>
          <span className="capitalize text-gray-800">{rupeesInWords(t.grand)}</span>
        </div>

        {/* Terms */}
        <div className="mt-5 grid grid-cols-2 gap-4 text-xs">
          <div>
            <div className="font-bold uppercase tracking-wide text-gray-400">Payment Terms</div>
            <p className="mt-1 text-gray-700">{po.payment_terms || 'As per standard terms agreed with supplier.'}</p>
          </div>
          <div>
            <div className="font-bold uppercase tracking-wide text-gray-400">Delivery Terms</div>
            <p className="mt-1 text-gray-700">{po.delivery_terms || 'Delivered to works, freight prepaid.'}</p>
          </div>
        </div>

        {po.vendor_notes && (
          <div className="mt-4 text-xs">
            <div className="font-bold uppercase tracking-wide text-gray-400">Special Instructions</div>
            <p className="mt-1 whitespace-pre-wrap text-gray-700">{po.vendor_notes}</p>
          </div>
        )}

        <div className="mt-4 text-xs text-gray-500">
          <div className="font-bold uppercase tracking-wide text-gray-400">Standard Terms</div>
          <ol className="mt-1 list-decimal space-y-0.5 pl-4">
            <li>Deliver to works quoting this PO number with a batch-wise packing list.</li>
            <li>Material is subject to incoming QC — rejections are returned at the supplier's cost.</li>
            <li>Tax invoice must quote this PO number, HSN codes and GST as charged above.</li>
            <li>Short or excess supply beyond ±2% requires prior written approval.</li>
          </ol>
        </div>

        {/* Signatures */}
        <div className="mt-12 grid grid-cols-2 gap-8 text-center text-xs text-gray-500 print:mt-8">
          <div className="border-t border-gray-300 pt-2">
            Prepared By{po.created_by ? <div className="text-[10px] text-gray-400">{po.created_by}</div> : null}
          </div>
          <div className="border-t border-gray-300 pt-2">For {coName} — Authorised Signatory</div>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, strong }) {
  return (
    <div className={`flex items-center justify-between py-0.5 ${strong ? 'text-ink-900' : 'text-gray-600'}`}>
      <span className={strong ? 'font-extrabold uppercase tracking-wide' : ''}>{label}</span>
      <span className={`tabular-nums ${strong ? 'text-base font-extrabold' : ''}`}>{value}</span>
    </div>
  );
}
