// How a Fluence prescription reads — on screen in the Fluence drawer and on the
// printed job card. Presentational only: every string comes from lib/fluence.js,
// so the card on the press and the drawer in Planning say the same thing.
import { RX_SLOTS, qtyText, unitFor, formatSchedule, lineHasDose, FLUENCE_CONTEXTS } from '../../lib/fluence.js';
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

// The dose lines as a table: one row per kit item, one column per time of day.
// A prescription written by weekday ("Monday & Thursday: 1 tablet" — how the
// Fluence cartons print it) uses none of the four times of day; those columns
// and an empty Frequency column are then left out, and the days get the room.
export function RxLinesTable({ rx, dense = false, print = false }) {
  const lines = rx?.lines || [];
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
  return (
    <div className={print ? '' : 'overflow-x-auto'}>
      <table className={`w-full border-collapse text-xs ${print ? 'text-black' : 'text-[#1D1D1F]'}`}>
        <thead>
          <tr className={print ? 'border-b-2 border-black' : 'border-b border-[#1D1D1F]/10 bg-[#1D1D1F]/[0.03]'}>
            <th className={`${th} w-6`}>#</th>
            <th className={`${th} min-w-[128px]`}>Item</th>
            {showDose && <th className={th}>Dose</th>}
            {showSlots && RX_SLOTS.map(s => <th key={s.key} className={`${th} w-[72px] text-center`}>{s.label}</th>)}
            {showOther && <th className={`${th} ${showSlots ? '' : 'min-w-[190px]'}`}>{showSlots ? 'Other time' : 'When'}</th>}
            {showFrequency && <th className={th}>Frequency</th>}
            {!itemsOnly && <th className={th}>Instructions</th>}
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={l.id ?? i} className={print ? 'border-b border-black/30' : 'border-b border-[#1D1D1F]/[0.06]'}>
              <td className={`${td} tabular-nums text-[#86868B]`}>{i + 1}</td>
              <td className={`${td} font-semibold`}>
                {rxItemName(l)}
                {l.pack_count != null && l.pack_count !== '' && <div className="text-[10px] font-normal text-[#6E6E73]">Pack of {qtyText(l.pack_count)}</div>}
              </td>
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
            </tr>
          ))}
        </tbody>
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

