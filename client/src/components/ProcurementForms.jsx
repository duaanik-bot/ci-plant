// Shared, reusable editors for the procurement forms. Defined at module scope
// (never inside a render body) so text inputs keep focus between keystrokes.
//   • PrLineEditor   — multi-item requisition lines (material · qty · est value)
//   • PoLineEditor   — full-GST purchase-order lines (HSN · rate · disc · GST)
//   • PoTotalsPanel  — CGST/SGST-or-IGST summary, freight, round-off, grand total
//   • TaxKindToggle  — intra-state (CGST+SGST) vs inter-state (IGST)
import { Button, Input, searchText, Select } from './ui.jsx';
import { fmt } from '../api.js';
import { Plus, XCircle } from 'lucide-react';
import { lineTaxable, lineAmount, poTotals } from '../lib/poTotals.js';
import { rupeesInWords } from '../lib/amountWords.js';
import { kgPerSheet, packets, totalWeight, ratePerSheet } from '../lib/boardMath.js';
import { unset } from '../lib/replenishment.js';

const cell = 'px-2 py-1.5 align-top';
const head = 'px-2 py-1.5 text-left text-[10px] font-bold uppercase tracking-wide text-slate-400';
const miniInput = 'w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm focus:border-brand-500 focus:outline-none';

// Pull a material's saved detail onto a line when it is picked. The rate is
// resolved via an INJECTED resolver (rateFor) — boards resolve to the vendor's
// ₹/sheet from the rate master, everything else to its std/last rate — so every
// PO path (Direct, Edit, convert-PR, bulk, quick-create) prices identically and
// nothing silently reaches for the drifting last_rate. Never clobbers a rate the
// buyer already typed. rate_source / rate_per_kg drive the provenance chip.
function fillFromMaterial(line, mat, rateFor) {
  if (!mat) return { material_id: '' };
  const resolved = rateFor?.(mat);
  return {
    material_id: String(mat.id),
    unit: mat.unit || line.unit || '',
    hsn_code: line.hsn_code || mat.hsn_code || '',
    gst_rate: line.gst_rate ? line.gst_rate : (mat.gst_rate ?? ''),
    rate: line.rate ? line.rate : (resolved?.rate != null ? String(resolved.rate) : ''),
    rate_source: resolved?.source ?? 'none',
    rate_per_kg: resolved?.rate_per_kg ?? null,
  };
}

// Where a PO line's rate came from — shown under the rate input. Boards read as
// "{grade} @ ₹{/kg} ({base|vendor})", flip to amber "Overridden" when the buyer
// has typed a rate that no longer matches the master, and amber "No rate on
// file" for a board with no rate for this vendor. Non-board std/last rates get a
// light muted note; a plain last_rate gets nothing.
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
    return <div className="mt-0.5 text-[10px] font-semibold text-amber-600">Overridden — master ₹{master.toFixed(2)}</div>;
  return <div className="mt-0.5 text-[10px] text-slate-400">{mat?.grade || 'Board'} @ ₹{rpk}/kg ({src})</div>;
}

function MaterialPicker({ value, materials, disabled, onPick, onQuickCreate }) {
  return (
    <div className="flex items-start gap-1.5">
      <div className="min-w-0 flex-1">
        <Select value={value || ''} disabled={disabled}
          onChange={e => onPick(materials.find(m => String(m.id) === e.target.value))}>
          <option value="">Select board…</option>
          {materials.filter(m => (m.active ?? 1) || String(m.id) === String(value))
            .map(m => <option key={m.id} value={m.id} data-search={searchText(m)}>{m.name}</option>)}
        </Select>
      </div>
      {onQuickCreate && (
        <button type="button" title="Create a new board" disabled={disabled}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-dashed border-slate-300 text-slate-400 transition-colors hover:border-brand-400 hover:bg-brand-50 hover:text-brand-600 disabled:cursor-not-allowed disabled:opacity-30"
          onClick={onQuickCreate}><Plus size={15} /></button>
      )}
    </div>
  );
}

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

// ── Requisition lines ─────────────────────────────────────────────────────────
// `stockFor(materialId)` is optional. When supplied, every line shows the live
// position under its material picker. Callers that do not pass it (the PR edit
// modal) render exactly as before.
export function PrLineEditor({ lines, materials, onChange, onQuickCreate, activePrsFor, rateFor, stockFor }) {
  const set = (i, patch) => onChange(lines.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const add = () => onChange([...lines, { material_id: '', qty: '', est_rate: '', unit: '', remarks: '' }]);
  const remove = i => onChange(lines.filter((_, j) => j !== i));
  const estValue = lines.reduce((s, l) => s + (+l.qty || 0) * (+l.est_rate || 0), 0);
  const ready = lines.filter(l => l.material_id && +l.qty > 0).length;

  return (
    <section className="ci-form-panel">
      <div className="ci-form-panel-title"><span>Requisition items</span><span>{ready} item{ready === 1 ? '' : 's'}</span></div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-sm">
          <thead><tr className="border-b border-slate-100">
            <th className={head}>Board</th><th className={`${head} w-24 text-right`}>Qty</th>
            <th className={`${head} w-20`}>UOM</th><th className={`${head} w-28 text-right`}>Est. Rate ₹</th>
            <th className={`${head} w-28 text-right`}>Est. Value ₹</th><th className={`${head} w-8`}></th>
          </tr></thead>
          <tbody>
            {lines.map((l, i) => {
              const dupes = activePrsFor ? activePrsFor(l.material_id) : [];
              return (
                <tr key={i} className="border-b border-slate-50 last:border-0">
                  <td className={cell}>
                    <MaterialPicker value={l.material_id} materials={materials}
                      onQuickCreate={onQuickCreate ? () => onQuickCreate(i) : undefined}
                      onPick={mat => set(i, fillFromMaterialPr(l, mat, rateFor))} />
                    {/* Code + grade·GSM under the picker: the board name already
                        carries the size, and the plant code is what the floor
                        reads. Together they identify the board without a wider row. */}
                    {(() => {
                      const mat = materials.find(m => String(m.id) === String(l.material_id));
                      if (!mat) return null;
                      const bits = [mat.spec, [mat.grade, mat.gsm ? `${mat.gsm} GSM` : null].filter(Boolean).join(' · ')]
                        .filter(Boolean);
                      return bits.length
                        ? <div className="mt-0.5 font-mono text-[10px] text-slate-400">{bits.join('  ·  ')}</div>
                        : null;
                    })()}
                    {l.material_id && dupes.length > 0 && (
                      <div className="mt-1 text-[11px] font-semibold text-amber-600">
                        {dupes.map(p => p.pr_number).join(', ')} already active — a re-raise will be confirmed.
                      </div>
                    )}
                    {l.material_id && stockFor && (
                      <StockStrip stock={stockFor(l.material_id)}
                        onUse={qty => set(i, { qty: String(qty) })} />
                    )}
                    <input placeholder="Item remark (optional)" value={l.remarks || ''}
                      onChange={e => set(i, { remarks: e.target.value })}
                      className={`${miniInput} mt-1 text-xs`} />
                  </td>
                  <td className={`${cell} text-right`}>
                    <input type="number" min="0" placeholder="0" value={l.qty}
                      onChange={e => set(i, { qty: e.target.value })} className={`${miniInput} text-right`} />
                  </td>
                  <td className={cell}><span className="inline-block pt-2 text-xs text-slate-500">{l.unit || '—'}</span></td>
                  <td className={`${cell} text-right`}>
                    <input type="number" min="0" step="0.01" placeholder="0.00" value={l.est_rate ?? ''}
                      onChange={e => set(i, { est_rate: e.target.value })} className={`${miniInput} text-right`} />
                  </td>
                  <td className={`${cell} text-right tabular-nums pt-2 text-slate-700`}>
                    {fmt.inr((+l.qty || 0) * (+l.est_rate || 0))}
                  </td>
                  <td className={cell}>
                    <button type="button" title="Remove item" disabled={lines.length === 1}
                      className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-300 hover:bg-red-50 hover:text-red-500 disabled:cursor-not-allowed disabled:opacity-30"
                      onClick={() => remove(i)}><XCircle size={15} /></button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
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
// PR lines have no HSN/GST fields — a lighter fill than the PO editor. The
// requisition estimate still resolves through the injected resolver (boards →
// base ₹/sheet, else std/last) rather than the drifting last_rate.
function fillFromMaterialPr(line, mat, rateFor) {
  if (!mat) return { material_id: '' };
  const resolved = rateFor?.(mat);
  return { material_id: String(mat.id), unit: mat.unit || '',
    est_rate: line.est_rate ? line.est_rate : (resolved?.rate != null ? String(resolved.rate) : '') };
}

// ── Purchase-order lines (full GST) ───────────────────────────────────────────
export function PoLineEditor({ lines, materials, onChange, onQuickCreate, lockFn, rateFor }) {
  const set = (i, patch) => onChange(lines.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const add = () => onChange([...lines, { material_id: '', qty: '', rate: '', hsn_code: '', unit: '', discount_pct: '', gst_rate: '' }]);
  const remove = i => onChange(lines.filter((_, j) => j !== i));
  const ready = lines.filter(l => l.material_id && +l.qty > 0).length;

  return (
    <section className="ci-form-panel">
      <div className="ci-form-panel-title"><span>PO items</span><span>{ready} line{ready === 1 ? '' : 's'} ready</span></div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[980px] text-sm">
          <thead><tr className="border-b border-slate-100">
            <th className={head}>Board</th><th className={`${head} w-24`}>HSN</th>
            <th className={`${head} w-20 text-right`}>Qty</th><th className={`${head} w-16`}>UOM</th>
            <th className={`${head} w-20 text-right`}>kg/Sheet</th><th className={`${head} w-16 text-right`}>Packets</th>
            <th className={`${head} w-24 text-right`}>Total kg</th>
            <th className={`${head} w-24 text-right`}>Rate ₹</th><th className={`${head} w-16 text-right`}>Disc %</th>
            <th className={`${head} w-16 text-right`}>GST %</th><th className={`${head} w-28 text-right`}>Amount ₹</th>
            <th className={`${head} w-8`}></th>
          </tr></thead>
          <tbody>
            {lines.map((l, i) => {
              const locked = lockFn ? lockFn(l) : false;
              const mat = materials.find(m => String(m.id) === String(l.material_id));
              const kps = kgPerSheet(mat);
              const qty = +l.qty;
              const pkts = qty > 0 ? packets(mat, qty) : null;
              const tkg = qty > 0 ? totalWeight(mat, qty) : null;
              return (
                <tr key={l.id ?? `new-${i}`} className="border-b border-slate-50 last:border-0">
                  <td className={cell}>
                    <MaterialPicker value={l.material_id} materials={materials} disabled={locked}
                      onQuickCreate={onQuickCreate && !locked ? () => onQuickCreate(i) : undefined}
                      onPick={mat => set(i, fillFromMaterial(l, mat, rateFor))} />
                    {locked && <div className="mt-0.5 text-[10px] font-semibold text-amber-600">{fmt.num(l.committed_qty)} received/in-QC — locked</div>}
                  </td>
                  <td className={cell}><input placeholder="HSN" value={l.hsn_code || ''}
                    onChange={e => set(i, { hsn_code: e.target.value })} className={miniInput} /></td>
                  <td className={`${cell} text-right`}><input type="number" min={locked ? l.committed_qty : 0} placeholder="0" value={l.qty}
                    onChange={e => set(i, { qty: e.target.value })} className={`${miniInput} text-right`} /></td>
                  <td className={cell}><input placeholder="unit" value={l.unit || ''}
                    onChange={e => set(i, { unit: e.target.value })} className={miniInput} /></td>
                  <td className={`${cell} pt-3 text-right tabular-nums text-slate-500`}>{kps != null ? kps.toFixed(4) : '—'}</td>
                  <td className={`${cell} pt-3 text-right tabular-nums text-slate-500`}>{pkts != null ? pkts.toFixed(2) : '—'}</td>
                  <td className={`${cell} pt-3 text-right tabular-nums text-slate-500`}>{tkg != null ? `${tkg.toFixed(2)} kg` : '—'}</td>
                  <td className={`${cell} text-right`}>
                    <input type="number" min="0" step="0.01" placeholder="0.00" value={l.rate}
                      onChange={e => set(i, { rate: e.target.value })} className={`${miniInput} text-right`} />
                    <RateProvenance line={l} mat={mat} />
                  </td>
                  <td className={`${cell} text-right`}><input type="number" min="0" max="100" step="0.01" placeholder="0" value={l.discount_pct ?? ''}
                    onChange={e => set(i, { discount_pct: e.target.value })} className={`${miniInput} text-right`} /></td>
                  <td className={`${cell} text-right`}><input type="number" min="0" step="0.01" placeholder="0" value={l.gst_rate ?? ''}
                    onChange={e => set(i, { gst_rate: e.target.value })} className={`${miniInput} text-right`} /></td>
                  <td className={`${cell} pt-3 text-right tabular-nums font-semibold text-slate-800`}>{fmt.inr(lineAmount(l))}</td>
                  <td className={cell}>
                    <button type="button" title={locked ? 'Received lines cannot be removed' : 'Remove line'} disabled={locked || lines.length === 1}
                      className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-300 hover:bg-red-50 hover:text-red-500 disabled:cursor-not-allowed disabled:opacity-30"
                      onClick={() => remove(i)}><XCircle size={15} /></button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
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
