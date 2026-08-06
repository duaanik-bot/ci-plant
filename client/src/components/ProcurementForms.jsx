// Shared, reusable editors for the procurement forms. Defined at module scope
// (never inside a render body) so text inputs keep focus between keystrokes.
//   • PrLineEditor   — multi-item requisition lines (material · qty · est value)
//   • PoLineEditor   — full-GST purchase-order lines (HSN · rate · disc · GST)
//   • PoTotalsPanel  — CGST/SGST-or-IGST summary, freight, round-off, grand total
//   • TaxKindToggle  — intra-state (CGST+SGST) vs inter-state (IGST)
import { Button } from './ui.jsx';
import { MaterialPicker } from './BoardPicker.jsx';
import { fmt } from '../api.js';
import { Plus, Copy, Trash2 } from 'lucide-react';
import { lineTaxable, lineAmount, poTotals } from '../lib/poTotals.js';
import { rupeesInWords } from '../lib/amountWords.js';
import { kgPerSheet, packets, totalWeight, ratePerSheet, packetRate, ratePerKgFromSheet } from '../lib/boardMath.js';
import { unset } from '../lib/replenishment.js';

const miniInput = 'w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm focus:border-brand-500 focus:outline-none';

// A line's own number, so a validation message can say "line 03" and be found.
function LineNo({ i }) {
  return (
    // ci-line-no keeps the index at its own 46px when a narrow dialog wraps the
    // row — it is a marker, not a field, and must never take a field's share.
    <div className="ci-line-no flex h-10 items-center justify-center rounded-lg bg-slate-50 text-xs font-black tabular-nums text-slate-400">
      {String(i + 1).padStart(2, '0')}
    </div>
  );
}

// Every typed number on a card wears a real label. A placeholder disappears the
// moment you type into it, which is exactly when a dense row of six numbers
// needs to stay legible.
function NumField({ label, hint, children }) {
  return (
    <label className="block min-w-0">
      <span className="mb-1 block truncate text-[10px] font-bold uppercase tracking-wide text-slate-400" title={label}>{label}</span>
      {children}
      {hint}
    </label>
  );
}

function IconBtn({ title, disabled, onClick, danger, children }) {
  const tone = danger
    ? 'text-slate-300 hover:bg-red-50 hover:text-red-500'
    : 'text-slate-400 hover:bg-blue-50 hover:text-blue-600';
  return (
    <button type="button" title={title} disabled={disabled} onClick={onClick}
      className={`flex h-8 w-8 items-center justify-center rounded-lg disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-slate-300 ${tone}`}>
      {children}
    </button>
  );
}

// Pull a material's saved detail onto a line when it is picked. The rate is
// resolved via an INJECTED resolver (rateFor) — boards resolve to the vendor's
// ₹/sheet from the rate master, everything else to its std/last rate — so every
// PO path (Direct, Edit, convert-PR, bulk, quick-create) prices identically and
// nothing silently reaches for the drifting last_rate. Never clobbers a rate the
// buyer already typed. rate_source / rate_per_kg drive the provenance chip.
// A board's ₹/sheet is DERIVED (kg-per-sheet × ₹/kg), so it arrives as a raw
// float — ₹6.404212998. Money in this system is two decimals: RateProvenance
// already prints the master as toFixed(2) and tolerates 0.005 of drift before it
// calls a rate overridden, so rounding here lands inside that tolerance and the
// buyer sees a rate they could have typed. Never round a rate the buyer entered.
const money = v => (v == null || v === '' ? '' : String(Math.round(+v * 100) / 100));

// A board's ₹/sheet is NOT rounded to money(): ₹/kg is the rate that was agreed
// and the rate that goes on the vendor's copy, and it is recovered by dividing
// ₹/sheet back out. Rounding ₹13.061006 to ₹13.06 would print that ₹81.50/kg
// board as ₹81.49/kg. Only rates with no ₹/kg behind them get the 2dp treatment,
// where the buyer typed the money figure directly and there is nothing to invert.
function fillFromMaterial(line, mat, rateFor) {
  if (!mat) return { material_id: '' };
  const resolved = rateFor?.(mat);
  const rpk = resolved?.rate_per_kg ?? null;
  return {
    material_id: String(mat.id),
    unit: mat.unit || line.unit || '',
    hsn_code: line.hsn_code || mat.hsn_code || '',
    gst_rate: line.gst_rate ? line.gst_rate : (mat.gst_rate ?? ''),
    rate: line.rate ? line.rate : (rpk != null ? String(resolved.rate ?? '') : money(resolved?.rate)),
    // Cleared on every pick — a ₹/kg left over from the previously chosen board
    // would price the new one at the old grade's rate.
    kg_rate: null,
    rate_source: resolved?.source ?? 'none',
    rate_per_kg: rpk,
  };
}

// Where a PO line's rate came from — shown under the rate input. Boards read as
// "{grade} @ ₹{/kg} ({base|vendor})", flip to amber "Overridden" when the buyer
// has typed a rate that no longer matches the master, and amber "No rate on
// file" for a board with no rate for this vendor. Non-board std/last rates get a
// light muted note; a plain last_rate gets nothing.
//
// The comparison runs on ₹/sheet because that is what the line stores, but the
// message quotes ₹/kg — the buyer is typing ₹/kg, so quoting a sheet rate they
// never entered would read as a different number entirely.
function RateProvenance({ line, mat }) {
  const src = line.rate_source;
  if (src === 'none') return <div className="mt-0.5 text-[10px] font-semibold text-amber-600">No rate on file</div>;
  if (src === 'std') return <div className="mt-0.5 text-[10px] text-slate-400">std rate</div>;
  if (src === 'last') return <div className="mt-0.5 text-[10px] text-slate-400">last rate</div>;
  if (src !== 'base' && src !== 'vendor') return null;
  const rpk = line.rate_per_kg;
  const master = ratePerSheet(mat, rpk);
  const typed = line.rate;
  if (master != null && typed !== '' && typed != null && Math.abs(+typed - master) > 0.005)
    return <div className="mt-0.5 text-[10px] font-semibold text-amber-600">Overridden — master ₹{(+rpk).toFixed(2)}/kg</div>;
  return <div className="mt-0.5 text-[10px] text-slate-400">{mat?.grade || 'Board'} @ ₹{rpk}/kg ({src})</div>;
}

// ── A board line is priced in ₹/kg ───────────────────────────────────────────
// The plant negotiates board by weight, so ₹/kg is the only rate a buyer should
// ever type. ₹/sheet stays the line's stored, transacting rate — qty is in
// sheets and every downstream reader (taxable, GRN, last_rate) counts on that —
// but it is now derived, never entered. ₹/packet is shown alongside because that
// is the unit the vendor quotes back on their invoice.
//
// `kg_rate` holds the buyer's raw keystrokes for this session only; it is not a
// column and the server drops it. Without it a half-typed "81." would be pushed
// through ×kg/sheet and inverted back on the next render, fighting the cursor.
const kgRateValue = (line, mat) => {
  if (line.kg_rate != null) return line.kg_rate;
  const r = ratePerKgFromSheet(mat, line.rate);
  // Inversion lands on a float (81.49999999999999). 4dp round-trips any real
  // ₹/kg the rate master can hold, and reads as the number that was agreed.
  return r == null ? '' : String(+r.toFixed(4));
};

// ── Live inventory on a requisition line ─────────────────────────────────────
// Procurement decisions get made against the position, not from memory. Every
// figure comes from /inventory/stock, so the strip agrees with the warehouse
// list by construction.
//
// Two kinds of number live here and they must NOT read the same way:
//
//   • Positions (available / reserved / incoming / suggested) are COUNTED. Zero
//     is a real answer. "Incoming 0" means nothing is on order; showing "—"
//     there would claim we don't know, and a buyer orders differently on
//     "nothing is coming" than on "unknown".
//   • Master band (reorder / min / max) is CONFIGURED. 0 means nobody has set
//     it, so it reads "—" — same rule boardMath follows for an incomplete
//     board, and the same reason suggestedQty treats max_stock 0 as "no cap".
const pos = v => <span className="tabular-nums font-semibold text-slate-700">{fmt.num(+v || 0)}</span>;
const band = v => (unset(v)
  ? <span className="text-slate-300">—</span>
  : <span className="tabular-nums font-semibold text-slate-700">{fmt.num(v)}</span>);

function StockStrip({ stock, onUse }) {
  if (!stock) return null;
  const pkt = packets(stock, stock.available);
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-slate-50/80 px-2.5 py-1.5 text-[11px] text-slate-500">
      <span>Available {pos(stock.available)}{pkt != null && +stock.available > 0
        ? <span className="ml-1 text-slate-400">({pkt.toLocaleString('en-IN', { maximumFractionDigits: 1 })} pkt)</span> : null}</span>
      <span>Reserved {pos(stock.reserved)}</span>
      <span>Incoming {pos(stock.incoming)}</span>
      <span>Reorder {band(stock.reorder_level)}</span>
      <span>Min {band(stock.min_stock)}</span>
      <span>Max {band(stock.max_stock)}</span>
      <span className="font-semibold text-slate-600">Suggested {pos(stock.suggested)}</span>
      {+stock.suggested > 0 && onUse && (
        <button type="button" onClick={() => onUse(stock.suggested)}
          className="rounded-md bg-brand-50 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-brand-600 transition-colors hover:bg-brand-100">
          Use
        </button>
      )}
    </div>
  );
}

// ── Quantity, in the two units the plant actually speaks ────────────────────
// Board is BOUGHT and STORED in packets and TRANSACTED in sheets, so a buyer
// asked for a sheet count is converting a packet count in his head — and the
// warehouse list beside him already reads both ways.
//
// Sheets stays the stored value: every line, allocation, GRN and consumption
// downstream is sheet-denominated, and one authoritative unit is what stops the
// two drifting. Packets is an entry and reading convenience on top of it, so
// typing either box fills the other.
//
// Fractions are allowed rather than snapped to whole packets: 2.5 pkt of a
// 100-sheet pack is a real 250 sheets, and rounding the field would quietly buy
// something other than what was typed. A board with no sheets/packet on its
// master simply has no packet box.
function QtyInUnits({ mat, qty, onQty, min = 0, className = '' }) {
  const per = +mat?.sheets_per_packet || 0;
  const pkt = per > 0 && qty !== '' && qty != null && !isNaN(+qty)
    ? +((+qty / per).toFixed(3))
    : '';
  return (
    <>
      <NumField label="Qty (sheets)">
        <input type="number" min={min} placeholder="0" value={qty}
          onChange={e => onQty(e.target.value)} className={`${miniInput} h-10 text-right ${className}`} />
      </NumField>
      <NumField label={per > 0 ? `Packets · ${fmt.num(per)}/pkt` : 'Packets'}>
        {per > 0 ? (
          <input type="number" min="0" step="0.01" placeholder="0" value={pkt}
            onChange={e => {
              const v = e.target.value;
              onQty(v === '' ? '' : String(Math.round(+v * per)));
            }}
            className={`${miniInput} h-10 text-right ${className}`} />
        ) : (
          <div className="flex h-10 items-center justify-end px-1 text-xs text-slate-300">—</div>
        )}
      </NumField>
    </>
  );
}

// ── Requisition lines ─────────────────────────────────────────────────────────
// `stockFor(materialId)` is optional. When supplied, every line shows the live
// position under its material picker. Callers that do not pass it (the PR edit
// modal) render exactly as before.
export function PrLineEditor({ lines, materials, onChange, onQuickCreate, activePrsFor, infoPrsFor, rateFor, stockFor }) {
  const set = (i, patch) => onChange(lines.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const add = () => onChange([...lines, { material_id: '', qty: '', est_rate: '', unit: '', remarks: '' }]);
  const clone = i => onChange([...lines.slice(0, i + 1), { ...lines[i] }, ...lines.slice(i + 1)]);
  const remove = i => onChange(lines.filter((_, j) => j !== i));
  const estValue = lines.reduce((s, l) => s + (+l.qty || 0) * (+l.est_rate || 0), 0);
  const ready = lines.filter(l => l.material_id && +l.qty > 0).length;

  return (
    <section className="ci-form-panel">
      <div className="ci-form-panel-title"><span>Requisition items</span><span>{ready} item{ready === 1 ? '' : 's'}</span></div>
      <div className="space-y-2">
        {lines.map((l, i) => {
          const dupes = activePrsFor ? activePrsFor(l.material_id) : [];
          // Another product's PR on the same board is information, never the
          // duplicate this editor warns about — only a same-nature PR blocks.
          const infoPrs = infoPrsFor ? infoPrsFor(l.material_id) : [];
          const mat = materials.find(m => String(m.id) === String(l.material_id));
          return (
            <div key={i} className="ci-line-item">
              <div className="ci-line-grid grid grid-cols-1 gap-2 md:grid-cols-[46px_minmax(0,1fr)_84px_84px_58px_96px_104px_68px] md:items-start">
                <LineNo i={i} />
                <div className="ci-line-key min-w-0">
                  <MaterialPicker value={l.material_id} materials={materials} rateFor={rateFor} stockFor={stockFor}
                    onQuickCreate={onQuickCreate ? () => onQuickCreate(i) : undefined}
                    onPick={m => set(i, fillFromMaterialPr(l, m, rateFor))} />
                  <BoardSpec mat={mat} />
                  {l.material_id && dupes.length > 0 && (
                    <div className="mt-1 text-[11px] font-semibold text-amber-600">
                      {dupes.map(p => p.pr_number).join(', ')} already active — a re-raise will be confirmed.
                    </div>
                  )}
                  {l.material_id && infoPrs.length > 0 && (
                    <div className="mt-1 text-[11px] font-medium text-slate-400">
                      Already under PR for other jobs — {fmt.num(infoPrs.reduce((s, p) => s + (+p.qty || 0), 0))} incoming
                      ({infoPrs.map(p => p.pr_number).join(', ')}). Not a duplicate of this one.
                    </div>
                  )}
                  {l.material_id && stockFor && (
                    <StockStrip stock={stockFor(l.material_id)} onUse={qty => set(i, { qty: String(qty) })} />
                  )}
                  <input placeholder="Item remark (optional)" value={l.remarks || ''}
                    onChange={e => set(i, { remarks: e.target.value })}
                    className={`${miniInput} mt-1.5 text-xs`} />
                </div>
                <QtyInUnits mat={mat} qty={l.qty} onQty={v => set(i, { qty: v })} />
                <NumField label="UOM">
                  <div className="flex h-10 items-center px-1 text-xs text-slate-500">{l.unit || '—'}</div>
                </NumField>
                <NumField label="Est. Rate ₹">
                  <input type="number" min="0" step="0.01" placeholder="0.00" value={l.est_rate ?? ''}
                    onChange={e => set(i, { est_rate: e.target.value })} className={`${miniInput} h-10 text-right`} />
                </NumField>
                <div className="rounded-lg bg-slate-50 px-2 py-2 text-right">
                  <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Est. Value</div>
                  <div className="tabular-nums text-xs font-bold text-slate-600">
                    {fmt.inr((+l.qty || 0) * (+l.est_rate || 0))}
                  </div>
                </div>
                <div className="flex items-center justify-end gap-0.5 md:h-10">
                  <IconBtn title="Clone item" onClick={() => clone(i)}><Copy size={14} /></IconBtn>
                  <IconBtn title="Remove item" danger disabled={lines.length === 1} onClick={() => remove(i)}><Trash2 size={15} /></IconBtn>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-3 flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={add}><Plus size={13} /> Add item</Button>
        <div className="text-sm font-semibold text-slate-600">
          Estimated value <span className="ml-1 tabular-nums text-slate-900">{fmt.inr(estValue)}</span>
        </div>
      </div>
    </section>
  );
}

// The spec code under the picker — the one identifier NOT already in the board
// name, and the one the floor actually reads off a packet. The old version also
// repeated grade and GSM here, which the name ('Duplex GB · 230 GSM · 20x38')
// states two lines above; HSN takes that slot instead, since it drives the tax
// on this line and is otherwise invisible until you look at the HSN field.
function BoardSpec({ mat }) {
  if (!mat) return null;
  const bits = [mat.spec, mat.hsn_code ? `HSN ${mat.hsn_code}` : null].filter(Boolean);
  if (!bits.length) return null;
  return <div className="mt-1 font-mono text-[10px] text-slate-400">{bits.join('  ·  ')}</div>;
}
// PR lines have no HSN/GST fields — a lighter fill than the PO editor. The
// requisition estimate still resolves through the injected resolver (boards →
// base ₹/sheet, else std/last) rather than the drifting last_rate.
function fillFromMaterialPr(line, mat, rateFor) {
  if (!mat) return { material_id: '' };
  const resolved = rateFor?.(mat);
  return { material_id: String(mat.id), unit: mat.unit || '',
    est_rate: line.est_rate ? line.est_rate : money(resolved?.rate) };
}

// ── Purchase-order lines (full GST) ───────────────────────────────────────────
// A PO line carries six typed fields to a sales-order line's three, so one row
// would re-create the squeeze this card was built to remove. Two tiers instead:
// tier 1 identifies and prices the line, tier 2 is the numbers. The derived strip
// (packets / kg-per-sheet / total kg) appears only once there is a qty and the
// board has a computable weight — an empty line stays short, and a board with no
// GSM prints nothing rather than three em-dashes.
export function PoLineEditor({ lines, materials, onChange, onQuickCreate, lockFn, rateFor, stockFor }) {
  const set = (i, patch) => onChange(lines.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const add = () => onChange([...lines, { material_id: '', qty: '', rate: '', hsn_code: '', unit: '', discount_pct: '', gst_rate: '' }]);
  // A cloned line is a NEW line: it must not inherit the original's id or its
  // received quantity, or the clone would arrive at the server already locked and
  // claiming stock it never received.
  const clone = i => {
    const { id, committed_qty, ...rest } = lines[i];
    onChange([...lines.slice(0, i + 1), rest, ...lines.slice(i + 1)]);
  };
  const remove = i => onChange(lines.filter((_, j) => j !== i));
  const ready = lines.filter(l => l.material_id && +l.qty > 0).length;

  return (
    <section className="ci-form-panel">
      <div className="ci-form-panel-title"><span>PO items</span><span>{ready} line{ready === 1 ? '' : 's'} ready</span></div>
      <div className="space-y-2">
        {lines.map((l, i) => {
          const locked = lockFn ? lockFn(l) : false;
          const mat = materials.find(m => String(m.id) === String(l.material_id));
          const kps = kgPerSheet(mat);
          const qty = +l.qty;
          const pkts = qty > 0 ? packets(mat, qty) : null;
          const tkg = qty > 0 ? totalWeight(mat, qty) : null;
          // ₹/packet is priced off the ₹/kg on THIS line, not the rate master —
          // a buyer who overrides the rate must see the packet price they are
          // actually ordering at, not the one the master would have charged.
          const pktRate = packetRate(mat, kgRateValue(l, mat));
          const derived = qty > 0 && (pkts != null || tkg != null || kps != null);
          return (
            <div key={l.id ?? `new-${i}`} className="ci-line-item">
              {/* Tier 1 — which board, for how much, and the row's own controls */}
              <div className="ci-line-grid grid grid-cols-1 gap-2 md:grid-cols-[46px_minmax(0,1fr)_128px_76px] md:items-start">
                <LineNo i={i} />
                <div className="ci-line-key min-w-0">
                  <MaterialPicker value={l.material_id} materials={materials} disabled={locked}
                    rateFor={rateFor} stockFor={stockFor}
                    onQuickCreate={onQuickCreate && !locked ? () => onQuickCreate(i) : undefined}
                    onPick={m => set(i, fillFromMaterial(l, m, rateFor))} />
                  <BoardSpec mat={mat} />
                  {locked && (
                    <div className="mt-1 text-[10px] font-semibold text-amber-600">
                      {fmt.num(l.committed_qty)} received/in-QC — locked
                    </div>
                  )}
                </div>
                <div className="rounded-lg bg-slate-50 px-3 py-2 text-right">
                  <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Amount</div>
                  <div className="tabular-nums text-sm font-bold text-slate-800">{fmt.inr(lineAmount(l))}</div>
                </div>
                <div className="flex items-center justify-end gap-0.5 md:h-10">
                  <IconBtn title="Clone line" onClick={() => clone(i)}><Copy size={14} /></IconBtn>
                  <IconBtn title={locked ? 'Received lines cannot be removed' : 'Remove line'} danger
                    disabled={locked || lines.length === 1} onClick={() => remove(i)}><Trash2 size={15} /></IconBtn>
                </div>
              </div>

              {/* Tier 2 — the numbers, each under its own label */}
              <div className="mt-2 grid grid-cols-2 gap-2 border-t border-slate-100 pt-2 sm:grid-cols-3 md:grid-cols-7">
                <NumField label="HSN">
                  <input placeholder="HSN" value={l.hsn_code || ''}
                    onChange={e => set(i, { hsn_code: e.target.value })} className={`${miniInput} h-10`} />
                </NumField>
                <QtyInUnits mat={mat} qty={l.qty} onQty={v => set(i, { qty: v })}
                  min={locked ? l.committed_qty : 0} />
                <NumField label="UOM">
                  <input placeholder="unit" value={l.unit || ''}
                    onChange={e => set(i, { unit: e.target.value })} className={`${miniInput} h-10`} />
                </NumField>
                {/* Board → ₹/kg typed, ₹/sheet derived. Anything without a
                    computable weight (consumables, services) keeps the plain
                    rate: there is no kg to price it by. */}
                {kps != null ? (
                <NumField label="Rate ₹/kg" hint={<>
                  {pktRate != null && (
                    <div className="mt-0.5 text-[10px] font-semibold tabular-nums text-brand-600">
                      = ₹{pktRate.toFixed(2)}/pkt
                    </div>
                  )}
                  <RateProvenance line={l} mat={mat} />
                </>}>
                  <input type="number" min="0" step="any" placeholder="0.00" value={kgRateValue(l, mat)}
                    onChange={e => {
                      const v = e.target.value;
                      set(i, { kg_rate: v, rate: v === '' ? '' : String(kps * +v) });
                    }} className={`${miniInput} h-10 text-right`} />
                </NumField>
                ) : (
                <NumField label="Rate ₹" hint={<RateProvenance line={l} mat={mat} />}>
                  <input type="number" min="0" step="any" placeholder="0.00" value={l.rate}
                    onChange={e => set(i, { rate: e.target.value })} className={`${miniInput} h-10 text-right`} />
                </NumField>
                )}
                <NumField label="Disc %">
                  <input type="number" min="0" max="100" step="0.01" placeholder="0" value={l.discount_pct ?? ''}
                    onChange={e => set(i, { discount_pct: e.target.value })} className={`${miniInput} h-10 text-right`} />
                </NumField>
                <NumField label="GST %">
                  <input type="number" min="0" step="0.01" placeholder="0" value={l.gst_rate ?? ''}
                    onChange={e => set(i, { gst_rate: e.target.value })} className={`${miniInput} h-10 text-right`} />
                </NumField>
              </div>

              {derived && (
                <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg bg-brand-50/70 px-2.5 py-1.5 text-[11px] text-brand-700">
                  {pkts != null && <span>{pkts.toFixed(2)} pkt</span>}
                  {kps != null && <span>{kps.toFixed(4)} kg/sheet</span>}
                  {tkg != null && <span className="font-semibold">{tkg.toFixed(2)} kg total</span>}
                  {pktRate != null && <span className="font-semibold">₹{pktRate.toFixed(2)}/pkt</span>}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="mt-3"><Button variant="ghost" size="sm" onClick={add}><Plus size={13} /> Add line</Button></div>
    </section>
  );
}

export function TaxKindToggle({ value, onChange }) {
  const opts = [['intra', 'Intra-state · CGST + SGST'], ['inter', 'Inter-state · IGST']];
  return (
    <div className="inline-flex rounded-xl border border-slate-200 bg-slate-50 p-0.5 text-xs font-semibold">
      {opts.map(([k, label]) => (
        <button key={k} type="button" onClick={() => onChange(k)}
          className={`rounded-lg px-3 py-1.5 transition-colors ${value === k ? 'bg-white text-brand-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>
          {label}
        </button>
      ))}
    </div>
  );
}

// Totals summary — freight input + auto round-off + grand total + words, plus a
// board-weight strip (sheets / packets / kg) rolled up across the board lines.
export function PoTotalsPanel({ lines, materials = [], taxKind, freight, roundOff, onFreight, onRoundOff }) {
  const t = poTotals(lines, { freight, taxKind, round_off: roundOff });
  // Weight roll-up: only board lines (a material with a computable weight)
  // contribute. Priced lines whose material has no gsm are surfaced as a small
  // note so a missing/incomplete master is visible rather than silently dropped.
  let sheets = 0, packs = 0, wt = 0, weighted = 0, noWeight = 0;
  for (const l of lines.filter(x => x.material_id && +x.qty > 0)) {
    const mat = materials.find(m => String(m.id) === String(l.material_id));
    const tkg = totalWeight(mat, +l.qty);
    if (tkg == null) { noWeight++; continue; }
    weighted++; sheets += +l.qty; wt += tkg;
    const pk = packets(mat, +l.qty); if (pk != null) packs += pk;
  }
  const Row = ({ label, value, strong }) => (
    <div className={`flex items-center justify-between py-1 ${strong ? 'text-slate-900' : 'text-slate-600'}`}>
      <span className={strong ? 'font-bold' : ''}>{label}</span>
      <span className={`tabular-nums ${strong ? 'font-bold' : ''}`}>{value}</span>
    </div>
  );
  return (
    <section className="ci-form-panel">
      <div className="ci-form-panel-title"><span>Tax &amp; totals</span><span>{t.taxKind === 'intra' ? 'CGST + SGST' : 'IGST'}</span></div>
      {weighted > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-x-6 gap-y-1 rounded-xl bg-brand-50/70 px-3 py-2 text-sm">
          <span className="text-[11px] font-bold uppercase tracking-wide text-brand-600">Board weight</span>
          <span className="text-slate-600">Total Sheets <b className="ml-1 tabular-nums text-slate-900">{fmt.num(sheets)}</b></span>
          <span className="text-slate-600">Total Packets <b className="ml-1 tabular-nums text-slate-900">{packs.toFixed(2)}</b></span>
          <span className="text-slate-600">Total Weight <b className="ml-1 tabular-nums text-slate-900">{wt.toFixed(2)} kg</b></span>
          {noWeight > 0 && <span className="text-[11px] font-semibold text-amber-600">{noWeight} line{noWeight > 1 ? 's' : ''} without weight</span>}
        </div>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        <div className="text-xs text-slate-500">
          <div className="mb-1 font-bold uppercase tracking-wide text-slate-400">GST breakup</div>
          {t.byRate.length === 0 ? <div className="text-slate-400">Add priced lines to see the tax split.</div> : (
            <table className="w-full">
              <thead><tr className="text-left text-[10px] uppercase text-slate-400">
                <th className="py-0.5">GST%</th><th className="py-0.5 text-right">Taxable</th><th className="py-0.5 text-right">Tax</th>
              </tr></thead>
              <tbody>{t.byRate.map(b => (
                <tr key={b.rate}><td className="py-0.5">{b.rate}%</td>
                  <td className="py-0.5 text-right tabular-nums">{fmt.inr(b.taxable)}</td>
                  <td className="py-0.5 text-right tabular-nums">{fmt.inr(b.tax)}</td></tr>
              ))}</tbody>
            </table>
          )}
        </div>
        <div className="text-sm">
          <Row label="Taxable value" value={fmt.inr(t.taxable)} />
          {t.discount > 0 && <Row label="Less: discount" value={`− ${fmt.inr(t.discount)}`} />}
          {t.taxKind === 'intra' ? <>
            <Row label="CGST" value={fmt.inr(t.cgst)} />
            <Row label="SGST" value={fmt.inr(t.sgst)} />
          </> : <Row label="IGST" value={fmt.inr(t.igst)} />}
          <div className="flex items-center justify-between py-1 text-slate-600">
            <span>Freight / other</span>
            <input type="number" min="0" step="0.01" placeholder="0.00" value={freight ?? ''}
              onChange={e => onFreight(e.target.value)}
              className="w-28 rounded-lg border border-gray-300 px-2 py-1 text-right text-sm focus:border-brand-500 focus:outline-none" />
          </div>
          <div className="flex items-center justify-between py-1 text-slate-600">
            <span>Round off</span>
            <input type="number" step="0.01" placeholder={fmt.num(t.round_off)} value={roundOff ?? ''}
              onChange={e => onRoundOff(e.target.value)}
              className="w-28 rounded-lg border border-gray-300 px-2 py-1 text-right text-sm focus:border-brand-500 focus:outline-none" />
          </div>
          <div className="mt-1 border-t border-slate-200 pt-2"><Row label="Grand Total" value={fmt.inr(t.grand)} strong /></div>
        </div>
      </div>
      <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs font-semibold capitalize text-slate-600">{rupeesInWords(t.grand)}</p>
    </section>
  );
}
