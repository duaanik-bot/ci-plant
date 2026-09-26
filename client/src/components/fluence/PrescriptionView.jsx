// How a Fluence prescription reads — on screen in the Fluence drawer and on the
// printed job card. Presentational only: every string comes from lib/fluence.js,
// so the card on the press and the drawer in Planning say the same thing.
import { Pencil } from 'lucide-react';
import { RX_SLOTS, qtyText, unitFor, formatSchedule, lineHasDose, formatDims, FLUENCE_CONTEXTS } from '../../lib/fluence.js';
import { fmt } from '../../api.js';

export const rxItemName = line => line?.item_name || line?.item_label || '—';

// "Revision 3 · 17 Sep, 12:40 · Anik Dua (MD) · from Planning"
export function rxStampText(rx) {
  if (!rx) return '';
  return [
    `Revision ${rx.revision}`,
    rx.updated_at ? fmt.dt(rx.updated_at) : null,
    rx.updated_by || null,
    rx.updated_from ? `from ${FLUENCE_CONTEXTS[rx.updated_from] || rx.updated_from}` : null,
  ].filter(Boolean).join(' · ');
}

const qtyCell = (line, key) => {
  const v = line?.[key];
  if (v == null || v === '' || +v === 0) return '';
  return qtyText(v);
};

// What the kit list says about an item, under its name: its form, its pack and
// its carton — "Tablet · Strip of 10 · 118 × 58 × 93 mm".
function ItemFacts({ c }) {
  const dims = formatDims(c);
  const some = [c.carton_l, c.carton_w, c.carton_h].some(x => x != null);
  const facts = [c.kind === 'packaging' ? 'Packaging component' : null, c.dosage_form, c.packaging_info].filter(Boolean);
  const codes = [c.product_code && `Code ${c.product_code}`, c.artwork_code && `AW ${c.artwork_code}`, c.erp_product_code && `ERP ${c.erp_product_code}`].filter(Boolean);
  return (
    <div className="text-[10px] font-normal text-[#6E6E73]">
      {facts.join(' · ')}{facts.length ? ' · ' : ''}
      {dims ? <span className="tabular-nums">{dims}</span> : <span className="font-medium text-amber-700">{some ? 'carton size incomplete' : 'carton size not known yet'}</span>}
      {codes.length > 0 && <span className="ml-1 font-mono text-[#86868B]">{codes.join(' · ')}</span>}
      {c.remarks && <div className="text-[#515154]">In this kit: {c.remarks}</div>}
    </div>
  );
}

// The dose lines as a table: one row per line, one column per time of day.
// A prescription written by weekday ("Monday & Thursday: 1 tablet" — how the
// Fluence cartons print it) uses none of the four times of day; those columns
// and an empty Frequency column are then left out, and the days get the room.
//
// Given the kit list (`components`) it is the kit AND its prescription in one
// table: an item's first line also says how many the box holds and the item's
// MRP in the kit, and an item the prescription does not name yet still gets its
// row. `onEditItem` puts a pencil on each item for its inner-product details.
export function RxLinesTable({ rx, dense = false, print = false, components = null, onEditItem = null }) {
  const kit = components ? new Map(components.map(c => [Number(c.inner_product_id), c])) : null;
  let lines = rx?.lines || [];
  if (kit) {
    const named = new Set(lines.filter(l => l.inner_product_id != null).map(l => Number(l.inner_product_id)));
    lines = [...lines, ...components.filter(c => !named.has(Number(c.inner_product_id)))
      .map(c => ({ inner_product_id: c.inner_product_id, item_name: c.name }))];
  }
  if (!lines.length) return null;
  // The kit's products as the customer master lists them, with no day-wise
  // schedule: a plain product list, not a grid of empty times.
  const itemsOnly = !lines.some(lineHasDose);
  const showDose = lines.some(l => l.dosage || l.dose_form);
  const showOther = !itemsOnly && lines.some(l => l.other_timing || (l.other_qty != null && +l.other_qty > 0));
  const showSlots = !itemsOnly && (lines.some(l => RX_SLOTS.some(s => qtyCell(l, s.key))) || !showOther);
  const showFrequency = lines.some(l => l.frequency);
  const th = `${dense ? 'px-1.5 py-1' : 'px-2 py-1.5'} text-left text-[10px] font-bold uppercase tracking-wider ${print ? 'text-black' : 'text-[#6E6E73]'}`;
  const td = `${dense ? 'px-1.5 py-1' : 'px-2 py-1.5'} align-top`;
  // An item's first line carries the kit's figures for it; a later line names
  // the line it follows ("same item as line 2").
  const firstLine = new Map();
  lines.forEach((l, i) => { const id = l.inner_product_id == null ? null : Number(l.inner_product_id); if (id != null && !firstLine.has(id)) firstLine.set(id, i); });
  const editCol = Boolean(kit && onEditItem);
  const totalUnits = kit ? components.reduce((s, c) => s + (+c.qty_per_kit || 0), 0) : 0;
  return (
    <div className={print ? '' : 'overflow-x-auto'}>
      <table className={`w-full border-collapse text-xs ${print ? 'text-black' : 'text-[#1D1D1F]'}`}>
        <thead>
          <tr className={print ? 'border-b-2 border-black' : 'border-b border-[#1D1D1F]/10 bg-[#1D1D1F]/[0.03]'}>
            <th className={`${th} w-6`}>#</th>
            <th className={`${th} min-w-[128px]`}>Item</th>
            {kit && <th className={`${th} text-right`}>Qty / kit</th>}
            {kit && <th className={`${th} text-right`}>MRP in kit</th>}
            {showDose && <th className={th}>Dose</th>}
            {showSlots && RX_SLOTS.map(s => <th key={s.key} className={`${th} w-[72px] text-center`}>{s.label}</th>)}
            {showOther && <th className={`${th} ${showSlots ? '' : 'min-w-[190px]'}`}>{showSlots ? 'Other time' : 'When'}</th>}
            {showFrequency && <th className={th}>Frequency</th>}
            {!itemsOnly && <th className={th}>Instructions</th>}
            {editCol && <th className={th} />}
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => {
            const id = l.inner_product_id == null ? null : Number(l.inner_product_id);
            const c = kit && id != null ? kit.get(id) : null;
            const first = id != null && firstLine.get(id) === i;
            return (
            <tr key={l.id ?? i} className={print ? 'border-b border-black/30' : 'border-b border-[#1D1D1F]/[0.06]'}>
              <td className={`${td} tabular-nums text-[#86868B]`}>{i + 1}</td>
              <td className={`${td} font-semibold`}>
                {rxItemName(l)}
                {l.pack_count != null && l.pack_count !== '' && <div className="text-[10px] font-normal text-[#6E6E73]">Pack of {qtyText(l.pack_count)}</div>}
                {kit && c && first && <ItemFacts c={c} />}
                {kit && c && !first && <div className="text-[10px] font-normal text-[#86868B]">Same item as line {firstLine.get(id) + 1}</div>}
                {kit && id != null && !c && <div className="text-[10px] font-medium text-amber-700">Not in the kit list</div>}
                {kit && id == null && <div className="text-[10px] font-normal text-[#86868B]">Not an item in the kit</div>}
              </td>
              {kit && <td className={`${td} text-right font-bold tabular-nums`}>{c && first ? qtyText(c.qty_per_kit) : ''}</td>}
              {kit && <td className={`${td} text-right tabular-nums`}>{c && first ? (c.mrp_in_kit != null ? fmt.inr(c.mrp_in_kit) : <span className="text-[#AEAEB2]">—</span>) : ''}</td>}
              {showDose && (
                <td className={td}>
                  {[l.dosage, l.dose_form].filter(Boolean).join(' · ') || (print ? '' : <span className="text-[#AEAEB2]">—</span>)}
                </td>
              )}
              {showSlots && RX_SLOTS.map(s => {
                const q = qtyCell(l, s.key);
                return (
                  <td key={s.key} className={`${td} text-center tabular-nums ${q ? 'font-bold' : ''}`}>
                    {q ? `${q}${l.dose_form ? ` ${unitFor(l.dose_form, l[s.key])}` : ''}` : (print ? '' : <span className="text-[#D1D1D6]">·</span>)}
                  </td>
                );
              })}
              {showOther && (
                <td className={td}>
                  {l.other_timing}
                  {l.other_qty != null && +l.other_qty > 0 && (
                    <>{l.other_timing ? ': ' : ''}<b>{qtyText(l.other_qty)}{l.dose_form ? ` ${unitFor(l.dose_form, l.other_qty)}` : ''}</b></>
                  )}
                </td>
              )}
              {showFrequency && <td className={td}>{l.frequency || ''}</td>}
              {!itemsOnly && (
                <td className={td}>
                  {l.instructions || ''}
                  {l.remarks && <div className="text-[10px] text-[#6E6E73]">Note: {l.remarks}</div>}
                </td>
              )}
              {editCol && (
                <td className={`${td} text-right`}>
                  {c && first && (
                    <button type="button" title={`Edit ${c.name} — carton size, codes, dosage form`} onClick={() => onEditItem(c)}
                      className="rounded-lg p-1 text-[#86868B] hover:bg-[#1D1D1F]/[0.06] hover:text-[#0064D2]"><Pencil size={12} /></button>
                  )}
                </td>
              )}
            </tr>
            );
          })}
        </tbody>
        {kit && components.length > 0 && (
          <tfoot>
            <tr>
              <td />
              <td className="px-2 py-1.5 text-[11px] font-semibold text-[#6E6E73]">{components.length} item{components.length > 1 ? 's' : ''} in the kit</td>
              <td className="px-2 py-1.5 text-right text-[11px] font-bold tabular-nums">{qtyText(totalUnits)} units</td>
              <td colSpan={20} />
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

// One product's prescription as short lines — the gang table's cell.
// "F-TRICHO GOLD: Morning: 1 + Night: 1"
export function RxCompact({ rx, empty = 'Not entered in the Fluence master', className = '' }) {
  const lines = (rx?.lines || []).filter(lineHasDose);
  if (rx && !lines.length && !rx.general_instructions && rx.lines?.length) {
    return (
      <div className={`leading-snug ${className}`}>
        {rx.lines.map(rxItemName).join(' · ')}
        <div className="text-[10px] text-gray-500">Customer master — no day-wise schedule</div>
      </div>
    );
  }
  if (!rx || (!lines.length && !rx.general_instructions)) {
    return <span className={`font-semibold text-amber-700 ${className}`}>{empty}</span>;
  }
  return (
    <div className={`space-y-0.5 ${className}`}>
      {lines.map((l, i) => {
        const schedule = formatSchedule(l, { units: false });
        const tail = [l.dosage, schedule, l.frequency, l.instructions].filter(Boolean).join(' · ');
        return (
          <div key={l.id ?? i} className="leading-snug">
            <span className="font-semibold">{rxItemName(l)}</span>{tail ? <>: {tail}</> : null}
          </div>
        );
      })}
      {rx.general_instructions && <div className="italic leading-snug">{rx.general_instructions}</div>}
    </div>
  );
}

// The brief's product-wise table for a gang: Product | Artwork Code | Prescription.
// Each carton keeps its own row — prescriptions are never merged.
export function ProductRxTable({ items, print = false, onOpen }) {
  const th = `px-2 py-1.5 text-left text-[10px] font-bold uppercase tracking-wider ${print ? 'text-black' : 'text-[#6E6E73]'}`;
  return (
    <table className={`w-full border-collapse text-xs ${print ? 'text-black' : 'text-[#1D1D1F]'}`}>
      <thead>
        <tr className={print ? 'border-b-2 border-black' : 'border-b border-[#1D1D1F]/10 bg-[#1D1D1F]/[0.03]'}>
          <th className={th}>Product</th>
          <th className={th}>Artwork Code</th>
          <th className={th}>Prescription</th>
        </tr>
      </thead>
      <tbody>
        {items.map(it => (
          <tr key={it.key ?? it.product_id} className={print ? 'border-b border-black/30' : 'border-b border-[#1D1D1F]/[0.06]'}>
            <td className="px-2 py-1.5 align-top">
              {onOpen ? (
                <button type="button" onClick={() => onOpen(it.product_id)} className="text-left font-semibold text-[#0064D2] hover:underline">
                  {it.product_name}
                </button>
              ) : <span className="font-semibold">{it.product_name}</span>}
              <div className="font-mono text-[10px] text-[#6E6E73]">{it.product_code}</div>
            </td>
            <td className="px-2 py-1.5 align-top font-mono">{it.party_artwork_code || '—'}</td>
            <td className="px-2 py-1.5 align-top"><RxCompact rx={it.prescription} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function RxGeneral({ rx, print = false }) {
  if (!rx?.general_instructions && !rx?.remarks) return null;
  return (
    <div className={`mt-2 space-y-1 text-xs ${print ? 'text-black' : 'text-[#1D1D1F]'}`}>
      {rx.general_instructions && <p><span className="font-bold">Instructions: </span>{rx.general_instructions}</p>}
      {rx.remarks && <p><span className="font-bold">Remarks: </span>{rx.remarks}</p>}
    </div>
  );
}

