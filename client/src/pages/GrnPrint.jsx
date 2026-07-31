// Printable goods receipt — the paper half of a GRN. A receipt has never had a
// document: it was a register row, and the store had nothing to hold on arrival
// and nothing to file against the supplier's invoice.
//
// Built from POPrint's structure on purpose — same company header, same A4
// print-fit sheet, same lineAmount / poTotals / rupeesInWords. A purchase order
// and its goods receipt are two sides of one transaction, and they must read as
// two pages of one set, not two designs.
import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api, fmt } from '../api.js';
import { Button } from '../components/ui.jsx';
import { lineAmount, poTotals } from '../lib/poTotals.js';
import { rupeesInWords } from '../lib/amountWords.js';
import { packets, totalWeight } from '../lib/boardMath.js';
import { Printer, ArrowLeft } from 'lucide-react';

const fmtKg = n => (n == null ? '' : n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const fmtPkt = n => (n == null ? '' : n.toLocaleString('en-IN', { maximumFractionDigits: 1 }));
const fmtPaise = n => `${n < 0 ? '− ₹' : '₹'}${Math.abs(+n || 0).toFixed(2)}`;
const isBoard = l => !!(l.grade && +l.gsm > 0);

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
  in_qc: 'Awaiting QC', part_qc: 'Part QC', accepted: 'Accepted',
  partly_accepted: 'Partly Accepted', rejected: 'Rejected',
};

// The line's QC decision, in the register's own words and the register's own
// tones — but as a flat label, not ui.jsx's StatusBadge. That badge is a
// whitespace-nowrap pill with a dot and 10px of side padding; inside a 186mm
// page it claimed 113px of table width and starved the Board column. Same
// vocabulary, a sixth of the ink.
const QC_TONE = {
  quarantine: 'bg-amber-50 text-amber-700',
  accepted: 'bg-emerald-50 text-emerald-700',
  rejected: 'bg-red-50 text-red-600',
};
function QcChip({ status }) {
  return (
    <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-bold capitalize ${QC_TONE[status] || 'bg-gray-100 text-gray-600'}`}>
      {(status || '').replace(/_/g, ' ')}
    </span>
  );
}

export default function GrnPrint() {
  const { id } = useParams();
  const [grn, setGrn] = useState(null);
  const [missing, setMissing] = useState(false);
  // Reset on every id, and ignore a reply that lands after the id moved on.
  // Without the reset a second receipt opened from an already-mounted print
  // page inherits the first one's `missing` and reads "no longer exists".
  useEffect(() => {
    let live = true;
    setGrn(null); setMissing(false);
    api.get(`/grns/${id}`).then(g => { if (live) setGrn(g); }).catch(() => { if (live) setMissing(true); });
    return () => { live = false; };
  }, [id]);
  if (missing) return (
    <div className="mx-auto max-w-4xl">
      <div className="no-print mb-4"><Link to="/procurement"><Button variant="secondary"><ArrowLeft size={14} /> Back</Button></Link></div>
      <p className="rounded-2xl border border-dashed bg-white py-16 text-center text-sm text-gray-400">
        That goods receipt no longer exists — it may have been rolled back or deleted.
      </p>
    </div>
  );
  if (!grn) return null;

  const co = grn.company || {};
  const coName = co.name || 'Colour Impressions';
  const coAddr = [co.address, co.city, co.state].filter(Boolean).join(', ');

  // ── What this document totals ────────────────────────────────────────────────
  // EVERY line, rejected ones included. This is the record of what physically
  // arrived on the truck and what the supplier invoiced for; QC rejection
  // happens afterwards, and is shown per line as a status rather than removed
  // from the money. The store hands this over on arrival and files it against
  // the supplier's invoice, so it has to reconcile to that invoice.
  //
  // This is DELIBERATELY a different number from grnRegisterValue on the server,
  // which excludes rejected lines because a refused lot never became a purchase.
  // Two different questions — "what arrived and was billed" vs "what we bought"
  // — so two different answers. Do not "fix" either one to match the other.
  const t = poTotals(grn.lines, { freight: grn.freight, taxKind: grn.tax_kind, round_off: grn.round_off });
  const totalQty = grn.lines.reduce((s, l) => s + (+l.qty || 0), 0);
  const intra = t.taxKind === 'intra';
  const rejected = grn.lines.filter(l => l.status === 'rejected').length;

  // Board-weight roll-up across board lines only — the store checks a delivery
  // by packets and kg, not by sheet count.
  const boardTot = grn.lines.reduce((a, l) => {
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
        <Button onClick={() => window.print()}><Printer size={14} /> Print GRN</Button>
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
            <div className="text-sm font-extrabold text-brand-600">GOODS RECEIPT NOTE</div>
            <div className="mt-1 text-xs text-gray-600">No: <b>{grn.grn_number}</b></div>
            <div className="text-xs text-gray-600">Received: <b>{fmt.date(grn.received_at)}</b></div>
            {grn.po_number
              ? <div className="text-xs text-gray-600">Against PO: <b>{grn.po_number}</b></div>
              : <div className="text-xs text-gray-600">Direct receipt — <b>no purchase order</b></div>}
            <div className="mt-0.5 text-[10px] font-bold uppercase tracking-wide text-gray-400">
              {intra ? 'CGST + SGST · Intra-state' : 'IGST · Inter-state'}
              {grn.header_status ? ` · ${STATUS_LABEL[grn.header_status] || grn.header_status}` : ''}
            </div>
          </div>
        </div>

        {/* Supplier + Received-at */}
        <div className="mt-4 grid grid-cols-2 gap-4">
          <div className="rounded-lg border border-gray-200 p-3">
            <div className="text-[10px] font-bold uppercase tracking-wide text-gray-400">Supplier</div>
            {/* A direct receipt may carry no vendor at all — a sample, an urgent
                over-the-counter buy. It says so rather than leaving the block
                blank, which reads as a document that lost its supplier. */}
            <div className={`mt-1 font-bold ${grn.vendor_name ? 'text-gray-900' : 'text-gray-400'}`}>
              {grn.vendor_name || 'Unknown supplier'}
            </div>
            {grn.vendor_address && <div className="text-xs text-gray-600">{grn.vendor_address}</div>}
            {(grn.vendor_city || grn.vendor_state) && <div className="text-xs text-gray-600">{[grn.vendor_city, grn.vendor_state].filter(Boolean).join(', ')}</div>}
            {grn.vendor_gstin && <div className="mt-0.5 text-xs text-gray-500">GSTIN: {grn.vendor_gstin}{grn.vendor_state_code ? ` · State code ${grn.vendor_state_code}` : ''}</div>}
            {grn.vendor_phone && <div className="text-xs text-gray-500">Ph: {grn.vendor_phone}</div>}
          </div>
          <div className="rounded-lg border border-gray-200 p-3">
            <div className="text-[10px] font-bold uppercase tracking-wide text-gray-400">Received At</div>
            <div className="mt-1 font-bold text-gray-900">{coName} — Works</div>
            {coAddr && <div className="text-xs text-gray-600">{coAddr}</div>}
            {co.gstin && <div className="mt-0.5 text-xs text-gray-500">GSTIN: {co.gstin}{co.state_code ? ` · State code ${co.state_code}` : ''}</div>}
          </div>
        </div>

        {/* Receipt context — what the gate recorded when the truck came in */}
        <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 rounded-lg bg-gray-50 px-4 py-3 sm:grid-cols-4">
          <Field label="Vehicle No" value={grn.vehicle_no} />
          <Field label="Supplier Invoice" value={grn.supplier_invoice_no} />
          <Field label="Invoice Date" value={grn.supplier_invoice_date ? fmt.date(grn.supplier_invoice_date) : null} />
          <Field label="Received By" value={grn.received_by} />
        </div>

        {/* Line items.
            table-fixed with an explicit colgroup, not auto layout. A receipt
            carries two columns a PO does not — Batch No and QC — and the print
            page is only 186mm wide. Left to size itself, the table gave the QC
            badge 113px and squeezed Board to 58px, wrapping every board name
            over ten lines and pushing a three-line receipt onto a second page.
            The widths below are the document's, not the browser's guess. */}
        <div className="mt-5 overflow-x-auto">
          <table className="w-full table-fixed text-sm">
            <colgroup>
              <col className="w-[3%]" /><col className="w-[24%]" /><col className="w-[8%]" />
              <col className="w-[12%]" /><col className="w-[9%]" /><col className="w-[8%]" />
              <col className="w-[6%]" /><col className="w-[6%]" /><col className="w-[12%]" />
              <col className="w-[12%]" />
            </colgroup>
            <thead>
              {/* 10px and no letter-spacing, one notch under POPrint's headings:
                  ten columns share 186mm, and a wrapped two-line heading costs
                  more than the tracking is worth. */}
              <tr className="bg-ink-900 text-left text-[10px] font-bold uppercase text-white">
                <th className="px-1.5 py-1.5">#</th><th className="px-1.5 py-1.5">Board</th>
                <th className="px-1.5 py-1.5">HSN</th><th className="px-1.5 py-1.5">Batch No</th>
                {/* The rupee sign rides on the heading, not on 20 cells — it is
                    the same "Rate ₹" the receipt form labels the field with. */}
                <th className="px-1.5 py-1.5 text-right">Qty</th><th className="px-1.5 py-1.5 text-right">Rate ₹</th>
                <th className="px-1.5 py-1.5 text-right">Disc</th>
                <th className="px-1.5 py-1.5 text-right">GST</th><th className="px-1.5 py-1.5 text-right">Amount</th>
                <th className="px-1.5 py-1.5">QC</th>
              </tr>
            </thead>
            <tbody>
              {grn.lines.map((l, i) => {
                const board = isBoard(l);
                const spec = board
                  ? [l.grade, +l.gsm > 0 ? `${l.gsm} GSM` : null,
                     (+l.sheet_l > 0 && +l.sheet_w > 0) ? `${l.sheet_l} × ${l.sheet_w}"` : null,
                    ].filter(Boolean).join(' · ')
                  : (l.spec || '');
                return (
                <tr key={l.id} className="border-b border-gray-100 align-top">
                  <td className="px-1.5 py-1.5 text-gray-500">{i + 1}</td>
                  <td className="px-1.5 py-1.5 font-semibold">{l.material_name}{spec ? <span className="block text-[10px] font-normal leading-tight text-gray-400">{spec}</span> : null}</td>
                  <td className="px-1.5 py-1.5 text-[11px] text-gray-500">{l.hsn_code || '—'}</td>
                  <td className="px-1.5 py-1.5 break-words font-mono text-[10px] leading-tight text-gray-600">{l.batch_no}</td>
                  <td className="px-1.5 py-1.5 text-right tabular-nums">{fmt.num(l.qty)}<span className="block text-[10px] font-normal text-gray-400">{l.unit}</span></td>
                  <td className="px-1.5 py-1.5 text-right tabular-nums">{(+l.rate || 0).toFixed(2)}</td>
                  <td className="px-1.5 py-1.5 text-right tabular-nums">{+l.discount_pct ? `${l.discount_pct}%` : '—'}</td>
                  <td className="px-1.5 py-1.5 text-right tabular-nums">{+l.gst_rate || 0}%</td>
                  <td className="px-1.5 py-1.5 text-right font-semibold tabular-nums">{fmt.inr(lineAmount(l))}</td>
                  {/* Per line, because whoever files this against the invoice has
                      to see which lots were refused. */}
                  <td className="px-1.5 py-1.5"><QcChip status={l.status} /></td>
                </tr>
                );
              })}
              <tr className="border-b border-gray-100 text-[11px] text-gray-500">
                <td className="px-1.5 py-1.5" colSpan={4}>{grn.lines.length} line{grn.lines.length === 1 ? '' : 's'} received</td>
                <td className="px-1.5 py-1.5 text-right tabular-nums">{fmt.num(totalQty)}</td>
                {boardTot.any
                  ? <td className="px-1.5 py-1.5 text-right tabular-nums" colSpan={5}>
                      <b className="text-gray-700">{fmtPkt(boardTot.packets)}</b> packets · <b className="text-gray-700">{fmtKg(boardTot.kg)} kg</b>
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
            {/* Round-off is a sub-rupee figure by construction, so it is the one
                line that keeps its paise: fmt.inr would render the usual −0.18
                as "₹-0", which reads as a typo on a document a supplier sees. */}
            {t.round_off !== 0 && <Row label="Round Off" value={fmtPaise(t.round_off)} />}
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

        {grn.remarks && (
          <div className="mt-3 text-xs">
            <div className="font-bold uppercase tracking-wide text-gray-400">Remarks</div>
            <p className="mt-1 whitespace-pre-wrap text-gray-700">{grn.remarks}</p>
          </div>
        )}

        <div className="mt-3 text-xs text-gray-500">
          <div className="font-bold uppercase tracking-wide text-gray-400">Note</div>
          <ol className="mt-1 list-decimal space-y-0.5 pl-4">
            <li>Every lot lands in quarantine on arrival and is released to stock only on QC acceptance.</li>
            <li>The totals above cover every line on this receipt as received and invoiced{rejected > 0 ? `, including ${rejected} rejected on QC` : ''} — the QC column shows each lot's decision.</li>
            <li>Rejected material is returned at the supplier's cost — raise a credit note against this receipt. Short or excess supply beyond ±2% requires prior written approval.</li>
          </ol>
        </div>

        {/* Signatures */}
        <div className="mt-10 grid grid-cols-3 gap-8 text-center text-xs text-gray-500 print:mt-6">
          <div className="border-t border-gray-300 pt-2">
            Received By{grn.received_by ? <div className="text-[10px] text-gray-400">{grn.received_by}</div> : null}
          </div>
          <div className="border-t border-gray-300 pt-2">Stores / QC</div>
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
