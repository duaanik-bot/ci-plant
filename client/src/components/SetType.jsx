// Set-type vocabulary — ONE spelling for the whole ERP (the gang-anchor rule:
// hand-rolled copies of a shared verdict drift, so the chip, its tones and the
// precedence live here and every page imports them).
//
// The stored tag is INTENT; two facts outrank it wherever the tag is read
// (mirrors server/src/set-type.js — change one, change both):
//   hold        — any member on hold parks the whole row; the run moves as one
//   gang_run_id — the line physically shares a sheet, so it can never be Single
//
// Print Planning maps the same three words onto card-level FACTS instead
// (press hold + gang membership) — see cardSetType there; the vocabulary and
// the chip stay identical either way.
import { Link2, PauseCircle, Square, ChevronDown } from 'lucide-react';

export const SET_TYPE_META = {
  single: { label: 'Single', icon: Square,      chip: 'border-slate-200 bg-slate-50 text-slate-600' },
  gang:   { label: 'Gang',   icon: Link2,       chip: 'border-violet-200 bg-violet-50 text-violet-700' },
  hold:   { label: 'Hold',   icon: PauseCircle, chip: 'border-amber-200 bg-amber-50 text-amber-700' },
};

export const rowSetType = r => ((r._gang || [r]).some(m => m.set_type === 'hold') ? 'hold'
  : r.gang_run_id ? 'gang' : (r.set_type || 'single'));
export const holdReasonOf = r => (r._gang || [r]).map(m => m.hold_reason).find(Boolean) || '';

// The chip a row or card wears. Editable rows get a ⌄ and open whatever menu
// the page wires through `toggle`; without `editable` the same chip renders
// inert — the tag is information there, not a control.
export function SetTypeChip({ type, reason, editable, toggle, open }) {
  const m = SET_TYPE_META[type] || SET_TYPE_META.single;
  const Icon = m.icon;
  return (
    <div className="flex flex-col items-start gap-0.5">
      <button type="button" disabled={!editable}
        onClick={e => { e.stopPropagation(); toggle?.(); }}
        title={editable ? 'Change set type' : undefined}
        className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[10px] font-bold transition-colors ${m.chip} ${editable ? 'cursor-pointer hover:brightness-[0.97]' : 'cursor-default'} ${open ? 'ring-1 ring-[#0A84FF]/40' : ''}`}>
        <Icon size={10} /> {m.label}{editable && <ChevronDown size={10} className="opacity-60" />}
      </button>
      {type === 'hold' && reason && (
        <span className="max-w-[104px] truncate text-[10px] text-amber-600/90" title={reason}>{reason}</span>
      )}
    </div>
  );
}
