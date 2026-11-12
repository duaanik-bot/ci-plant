// Small pieces the Status Sheet › Reports table and its drawer share, so a
// status tag or a stage tag reads the same in both places.
import { DELIVERY_LABEL, WHERE_BEFORE, WHERE_LABEL } from '../lib/statusReport.js';
import { SECTION_META } from '../sections.js';

const PILL = {
  pending: 'bg-amber-50 text-amber-700',
  part: 'bg-blue-50 text-blue-700',
  delivered: 'bg-emerald-50 text-emerald-700',
  cancelled: 'bg-slate-100 text-slate-500',
};
export const Pill = ({ k }) => (
  <span className={`inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ${PILL[k] || ''}`}>{DELIVERY_LABEL[k] || k}</span>
);

// Where a line is, as a word: plant stages are named by SECTION_META (the one
// source for station names), the rest by WHERE_LABEL.
export const whereLabel = k => WHERE_LABEL[k] || SECTION_META[k]?.label || String(k || '').replace(/_/g, ' ');
const whereTone = k => (WHERE_BEFORE.includes(k) ? 'bg-slate-100 text-slate-600'
  : k === 'done' ? 'bg-teal-50 text-teal-700'
  : k === 'delivered' ? 'bg-emerald-50 text-emerald-700'
  : k === 'cancelled' ? 'bg-slate-100 text-slate-400'
  : 'bg-sky-50 text-sky-700');
export const WhereChip = ({ k, count }) => (
  <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ${whereTone(k)}`}>
    {whereLabel(k)}{count != null && <span className="tabular-nums opacity-70">{count}</span>}
  </span>
);

// A name in the report that opens the drawer. A real button, so it is
// reachable by keyboard; stopPropagation so a row click never fires as well.
export function NameLink({ onOpen, title, className = '', children }) {
  return (
    <button type="button" title={title}
      onClick={e => { e.stopPropagation(); onOpen(); }}
      className={`text-left font-semibold text-[#0064D2] underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0071F0]/40 rounded ${className}`}>
      {children}
    </button>
  );
}
