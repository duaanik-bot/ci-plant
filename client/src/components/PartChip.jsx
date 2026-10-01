import { partChipText } from '../lib/cartonParts.js';

// "Part 1 · for SW-715" + the whole carton's board at a glance.
export default function PartChip({ row, summary }) {
  const text = partChipText(row);
  if (!text) return null;
  const s = summary?.get(row.part_of_line_id);
  const tone = s?.state === 'covered' ? 'text-emerald-700' : s?.state === 'on_order' ? 'text-amber-700' : 'text-red-700';
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
      <span className="rounded-md border border-sky-200 px-1.5 py-0.5 font-semibold text-sky-700">{text}</span>
      {s && <span className={tone}>Carton board: {s.covered} of {s.total} parts covered</span>}
    </div>
  );
}
