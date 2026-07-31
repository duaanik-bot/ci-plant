// Goods-receipt line editor. A GRN is a purchase order on the receiving side —
// one header, many priced lines — so it is built from the PO form's own card
// primitives rather than a lookalike of them: the same LineNo / NumField /
// IconBtn / BoardSpec / RateProvenance, the same two-tier layout, and the same
// lineAmount. A buyer who knows the PO screen already knows this one, and the
// two documents cannot drift apart in either look or arithmetic.
//
// Kept OUT of ProcurementForms.jsx deliberately: that file is already long and
// under concurrent edit, and nothing here is wanted by the PO forms.
import { Button } from './ui.jsx';
import { MaterialPicker } from './BoardPicker.jsx';
import { fmt } from '../api.js';
import { Plus, Copy, Trash2 } from 'lucide-react';
import { lineAmount, rateVariance } from '../lib/poTotals.js';
import { kgPerSheet, packets, totalWeight } from '../lib/boardMath.js';
import {
  LineNo, NumField, IconBtn, BoardSpec, RateProvenance, miniInput, fillFromMaterial,
} from './ProcurementForms.jsx';

// ── Receipt lines ────────────────────────────────────────────────────────────
// Two modes, one card, because the money half of a receipt is identical either
// way — a rate, a discount, a GST slab and an amount — and only the identity
// half differs:
//
//   • 'direct' — nothing was ordered, so the receiver picks the board and prices
//     it. Lines can be added, cloned and removed: the truck decides how many.
//   • 'po'     — the board and the commercial terms are already agreed. The
//     board is FIXED (a receipt that could repoint itself at another material
//     would silently break the PO balance it is netting off), Ordered and
//     Balance are shown read-only for context, and Qty becomes Receive Now.
//     The rate is pre-filled from the PO and stays editable — the supplier may
//     have invoiced differently, and the GRN records what actually arrived
//     while the PO keeps what was ordered. The gap between the two is the
//     variance chip below.
//
// `qty` carries the received quantity in BOTH modes, never the ordered one, so
// poTotals / lineAmount price the receipt with no GRN-specific branch.
export function GrnLineEditor({ mode, lines, materials, onChange, onQuickCreate, rateFor, stockFor }) {
  const direct = mode !== 'po';
  const set = (i, patch) => onChange(lines.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const add = () => onChange([...lines, { material_id: '', qty: '', rate: '', hsn_code: '',
    unit: '', discount_pct: '', gst_rate: '', batch_no: '' }]);
  // A cloned line is a NEW line. It must not inherit the original's batch
  // number: two batches of one receipt sharing a number is exactly the
  // collision grnBatchNo's per-line suffix exists to prevent.
  const clone = i => {
    const { batch_no, ...rest } = lines[i];
    onChange([...lines.slice(0, i + 1), { ...rest, batch_no: '' }, ...lines.slice(i + 1)]);
  };
  const remove = i => onChange(lines.filter((_, j) => j !== i));
  const ready = lines.filter(l => l.material_id && +l.qty > 0).length;

  return (
    <section className="ci-form-panel">
      <div className="ci-form-panel-title">
        <span>Receipt items</span><span>{ready} line{ready === 1 ? '' : 's'} ready</span>
      </div>
      <div className="space-y-2">
        {lines.map((l, i) => {
          const mat = materials.find(m => String(m.id) === String(l.material_id));
          const kps = kgPerSheet(mat);
          const qty = +l.qty;
          const pkts = qty > 0 ? packets(mat, qty) : null;
          const tkg = qty > 0 ? totalWeight(mat, qty) : null;
          const derived = qty > 0 && (pkts != null || tkg != null || kps != null);
          const variance = rateVariance(l.rate, l.po_rate);
          return (
            <div key={l.po_line_id ?? `new-${i}`} className="ci-line-item">
              {/* Tier 1 — which board, what it comes to, and the row's own controls */}
              <div className={`grid grid-cols-1 gap-2 md:items-start ${direct
                ? 'md:grid-cols-[46px_minmax(0,1fr)_128px_76px]'
                : 'md:grid-cols-[46px_minmax(0,1fr)_128px]'}`}>
                <LineNo i={i} />
                <div className="min-w-0">
                  {direct ? (
                    <MaterialPicker value={l.material_id} materials={materials}
                      rateFor={rateFor} stockFor={stockFor}
                      onQuickCreate={onQuickCreate ? () => onQuickCreate(i) : undefined}
                      onPick={m => set(i, fillFromMaterial(l, m, rateFor))} />
                  ) : (
                    // Fixed board. Rendered as text, not a disabled picker: there
                    // is no choice to make here, and a greyed-out control invites
                    // one anyway.
                    <div className="flex h-10 items-center rounded-xl bg-slate-50 px-3 text-sm font-semibold text-slate-700">
                      <span className="truncate" title={l.material_name}>{l.material_name || mat?.name || '—'}</span>
                    </div>
                  )}
                  <BoardSpec mat={mat} />
                  <input placeholder="Supplier batch no (auto if blank)" value={l.batch_no || ''}
                    onChange={e => set(i, { batch_no: e.target.value })}
                    className={`${miniInput} mt-1.5 text-xs`} />
                </div>
                <div className="rounded-lg bg-slate-50 px-3 py-2 text-right">
                  <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Amount</div>
                  <div className="tabular-nums text-sm font-bold text-slate-800">{fmt.inr(lineAmount(l))}</div>
                </div>
                {/* A PO receipt's lines come from the order — there is nothing to
                    add, clone or delete, so the column is absent rather than
                    disabled. */}
                {direct && (
                  <div className="flex items-center justify-end gap-0.5 md:h-10">
                    <IconBtn title="Clone line" onClick={() => clone(i)}><Copy size={14} /></IconBtn>
                    <IconBtn title="Remove line" danger
                      disabled={lines.length === 1} onClick={() => remove(i)}><Trash2 size={15} /></IconBtn>
                  </div>
                )}
              </div>

              {/* Tier 2 — the numbers, each under its own label */}
              <div className="mt-2 grid grid-cols-2 gap-2 border-t border-slate-100 pt-2 sm:grid-cols-3 md:grid-cols-6">
                {direct ? (
                  <NumField label="HSN">
                    <input placeholder="HSN" value={l.hsn_code || ''}
                      onChange={e => set(i, { hsn_code: e.target.value })} className={`${miniInput} h-10`} />
                  </NumField>
                ) : (
                  <NumField label="Ordered">
                    <div className="flex h-10 items-center justify-end px-1 text-sm tabular-nums text-slate-500">
                      {fmt.num(l.ordered_qty)}
                    </div>
                  </NumField>
                )}
                {!direct && (
                  <NumField label="Balance">
                    <div className="flex h-10 items-center justify-end px-1 text-sm font-semibold tabular-nums text-amber-600">
                      {fmt.num(l.balance_qty)}
                    </div>
                  </NumField>
                )}
                <NumField label={direct ? 'Qty' : 'Receive Now'}>
                  <input type="number" min="0" placeholder="0" value={l.qty}
                    onChange={e => set(i, { qty: e.target.value })} className={`${miniInput} h-10 text-right`} />
                </NumField>
                {direct && (
                  <NumField label="UOM">
                    <input placeholder="unit" value={l.unit || ''}
                      onChange={e => set(i, { unit: e.target.value })} className={`${miniInput} h-10`} />
                  </NumField>
                )}
                {/* Direct lines price off the board-rate master, so they carry the
                    same provenance chip a PO line does. A PO receipt instead
                    compares against the rate that was actually ordered. */}
                <NumField label="Rate ₹" hint={direct ? <RateProvenance line={l} mat={mat} /> : (
                  variance != null
                    ? <div className="mt-0.5 text-[10px] font-semibold text-amber-600">
                        PO rate ₹{(+l.po_rate).toFixed(2)}
                      </div>
                    : null
                )}>
                  <input type="number" min="0" step="0.01" placeholder="0.00" value={l.rate}
                    onChange={e => set(i, { rate: e.target.value })} className={`${miniInput} h-10 text-right`} />
                </NumField>
                <NumField label="Disc %">
                  <input type="number" min="0" max="100" step="0.01" placeholder="0" value={l.discount_pct ?? ''}
                    onChange={e => set(i, { discount_pct: e.target.value })} className={`${miniInput} h-10 text-right`} />
                </NumField>
                <NumField label="GST %">
                  <input type="number" min="0" step="0.01" placeholder="0" value={l.gst_rate ?? ''}
                    onChange={e => set(i, { gst_rate: e.target.value })} className={`${miniInput} h-10 text-right`} />
                </NumField>
              </div>

              {/* Only once there is a quantity and the board has a computable
                  weight — an empty line stays short, and a board with no GSM
                  prints nothing rather than three em-dashes. */}
              {derived && (
                <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg bg-brand-50/70 px-2.5 py-1.5 text-[11px] text-brand-700">
                  {pkts != null && <span>{pkts.toFixed(2)} pkt</span>}
                  {kps != null && <span>{kps.toFixed(4)} kg/sheet</span>}
                  {tkg != null && <span className="font-semibold">{tkg.toFixed(2)} kg total</span>}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {direct && (
        <div className="mt-3"><Button variant="ghost" size="sm" onClick={add}><Plus size={13} /> Add line</Button></div>
      )}
    </section>
  );
}
