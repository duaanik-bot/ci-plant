// The calculation behind one enquiry, in its drawer (owner, 21 Nov 2026: "all the insights underneath that in the openable
// drawer once we click it, to have the detailed insight of the calculation"). Internal only — cost, margin and loss never
// reach the customer.
//   1. Per quantity: what we calculate (our actual cost, the costing's should-cost), what we give, what they ask — and what
//      our price and their price each make over our cost, a carton, as a % and on the quantity.
//   2. The order booked, when it was won: the rate, and the profit or loss on it.
//   3. The costing itself, line by line (board, printing, coating, die & pasting, process, P&F, misc), each with its working.
import { useEffect, useState } from 'react';
import { Calculator } from 'lucide-react';
import { api } from '../../api.js';
import { computeCosting } from '../../lib/costing.js';
import { bookedPL, qtyText, rupees } from '../../lib/enquiryUi.js';

const tone = v => (v == null ? 'text-slate-400' : v < 0 ? 'text-red-700' : 'text-emerald-700');
const sRs = (v, dp = 3) => (v == null ? '—' : `${v < 0 ? '−' : '+'}${rupees(Math.abs(v), dp)}`);
const sPct = v => (v == null ? '' : `${v < 0 ? '−' : '+'}${Math.abs(v).toFixed(1)}%`);
// price against our cost: ₹ a carton, % of cost, ₹ on the quantity
const gap = (price, cost, qty) => {
  const p = Number(price), c = Number(cost);
  if (!(p > 0) || !(c > 0)) return null;
  return { unit: p - c, pct: ((p - c) / c) * 100, total: (p - c) * (Number(qty) || 0) };
};
function Gap({ g }) {
  if (!g) return <span className="text-slate-400">—</span>;
  return (
    <span className={`tabular-nums ${tone(g.unit)}`}>
      <b>{sRs(g.unit)}</b> · {sPct(g.pct)}
      <span className="block text-[10px]">{sRs(g.total, 0)} on the quantity</span>
    </span>
  );
}

function Box({ title, right, children }) {
  return (
    <section className="rounded-[20px] border border-white/75 bg-white/55 p-3.5">
      <div className="mb-2 flex items-center gap-2"><h3 className="text-xs font-bold uppercase tracking-wide text-slate-500">{title}</h3><div className="ml-auto">{right}</div></div>
      {children}
    </section>
  );
}

export default function EnquiryInsight({ e, onOpenCosting }) {
  const [costing, setCosting] = useState(null);
  const [why, setWhy] = useState(null);
  useEffect(() => {
    setCosting(null); setWhy(null);
    if (!e?.costing_id || !e.costing_live) return undefined;
    let live = true;
    api.get(`/costing/costings/${e.costing_id}`).then(c => live && setCosting(c)).catch(x => live && setWhy(x?.message || 'could not be read'));
    return () => { live = false; };
  }, [e?.costing_id, e?.costing_live, e?.costing_version]);

  if (!e) return null;
  const prices = e.prices || [];
  const pl = bookedPL(e);
  const calc = costing?.inputs ? computeCosting(costing.inputs) : null;

  return (
    <div className="space-y-3">
      <Box title="The price, quantity by quantity">
        {!prices.length ? <p className="text-xs text-slate-500">Not costed yet — the prices show here once its costing is complete.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-left text-[10px] uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="py-1 pr-2 text-right">Qty</th>
                  <th className="px-2 py-1 text-right" title="Our actual cost a carton, before margin">Our cost</th>
                  <th className="px-2 py-1 text-right" title="What the costing works out to quote">We calculate</th>
                  <th className="px-2 py-1 text-right">We give</th>
                  <th className="px-2 py-1 text-right">They ask</th>
                  <th className="px-2 py-1">Our price vs cost</th>
                  <th className="px-2 py-1">Their price vs cost</th>
                </tr>
              </thead>
              <tbody>
                {prices.map(p => {
                  const give = p.final ?? p.ours;
                  return (
                    <tr key={p.qty} className="border-t border-slate-100 align-top">
                      <td className="py-1.5 pr-2 text-right font-bold">{qtyText(p.qty)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-slate-600">{p.cost != null ? rupees(p.cost, 3) : '—'}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{p.proposed != null ? rupees(p.proposed, 3) : '—'}</td>
                      <td className="px-2 py-1.5 text-right font-bold tabular-nums">{give != null ? rupees(give, 3) : '—'}</td>
                      <td className="px-2 py-1.5 text-right font-bold tabular-nums text-amber-800">{p.theirs != null ? rupees(p.theirs, 3) : Number(e.target_price) > 0 ? <span title="The target price in their enquiry">{rupees(e.target_price, 3)}*</span> : '—'}</td>
                      <td className="px-2 py-1.5"><Gap g={gap(give, p.cost, p.qty)} /></td>
                      <td className="px-2 py-1.5"><Gap g={gap(p.theirs ?? (Number(e.target_price) > 0 ? e.target_price : null), p.cost, p.qty)} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {Number(e.target_price) > 0 && !prices.some(p => p.theirs != null) && <p className="mt-1 text-[10px] text-slate-500">* the target price their enquiry named</p>}
          </div>
        )}
      </Box>

      {pl && (
        <Box title={`Order ${e.order_no || ''} — booked`}>
          <div className="flex flex-wrap gap-4 text-sm">
            <div><div className="text-[10px] uppercase text-slate-500">Quantity</div><b>{qtyText(pl.qty)}</b></div>
            <div><div className="text-[10px] uppercase text-slate-500">Rate agreed</div><b>{rupees(pl.rate, 2)}</b></div>
            <div><div className="text-[10px] uppercase text-slate-500">Our cost</div><b>{rupees(pl.cost, 3)}</b></div>
            <div><div className="text-[10px] uppercase text-slate-500">Order value</div><b>{rupees(pl.value, 0)}</b></div>
            <div><div className="text-[10px] uppercase text-slate-500">{pl.total < 0 ? 'Loss' : 'Profit'}</div><b className={tone(pl.total)}>{sRs(pl.total, 0)} · {sPct(pl.pct)}</b></div>
          </div>
        </Box>
      )}

      {e.costing_no && (
        <Box title={`How ${e.costing_no} is worked out`}
          right={onOpenCosting && <button type="button" onClick={onOpenCosting} className="inline-flex items-center gap-1 text-xs font-bold text-brand-600 hover:underline"><Calculator size={12} />Open the costing</button>}>
          {why ? <p className="text-xs text-red-700">{e.costing_no} {why}.</p>
            : !costing ? <p className="text-xs text-slate-400">{e.costing_live ? 'Reading the costing…' : `${e.costing_no} is hidden — no working to show.`}</p>
              : !calc?.ok ? <p className="text-xs text-amber-800">Not complete yet — still to fill in: {(calc?.missing || []).map(m => m.label).join(', ') || 'its inputs'}.</p> : (
                <>
                  <p className="mb-2 text-[11px] text-slate-500">Costed at {qtyText(costing.inputs?.qty)} cartons
                    {costing.inputs?.sheet_l && costing.inputs?.sheet_w ? ` · sheet ${costing.inputs.sheet_l} × ${costing.inputs.sheet_w} in` : ''}
                    {costing.inputs?.ups ? ` · ${costing.inputs.ups} ups` : ''}{costing.inputs?.gsm ? ` · ${costing.inputs.gsm} gsm` : ''}
                    {costing.status === 'approved' ? ` · approved by ${costing.approved_by_name || 'Management'}` : ' · draft, not approved'}</p>
                  <table className="w-full text-xs">
                    <thead className="text-left text-[10px] uppercase tracking-wide text-slate-500">
                      <tr><th className="py-1 pr-2">Line</th><th className="px-2 py-1 text-right">A carton</th><th className="px-2 py-1 text-right">On the job</th><th className="px-2 py-1">How</th></tr>
                    </thead>
                    <tbody>
                      {calc.lines.map(l => (
                        <tr key={l.key} className={`border-t border-slate-100 align-top ${l.total ? 'font-bold' : ''}`}>
                          <td className="py-1 pr-2">{l.label}</td>
                          <td className="px-2 py-1 text-right tabular-nums">{l.per_unit != null ? rupees(l.per_unit, 3) : ''}</td>
                          <td className="px-2 py-1 text-right tabular-nums">{l.amount != null ? rupees(l.amount, 0) : ''}</td>
                          <td className="px-2 py-1 text-[11px] font-normal text-slate-500">{l.how}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
        </Box>
      )}
    </div>
  );
}
