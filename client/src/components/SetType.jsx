// Set-type vocabulary — ONE spelling for the whole ERP (the gang-anchor rule:
// hand-rolled copies of a shared verdict drift, so the chip, its tones and the
// precedence live here and every page imports them).
//
// The stored tag is INTENT; two facts outrank it wherever the tag is read
// (mirrors server/src/set-type.js — change one, change both):
//   hold                — any member on hold parks the whole row; the run
//                         moves as one
//   run_kind === 'gang' — the line shares its sheet with OTHER PRODUCTS and
//                         splits after die cutting, so it can never be Single
//
// A COMBINED RUN (run_kind 'merge') is deliberately NOT in that list. It
// reuses gang_run_id so every "which card is this line riding?" lateral keeps
// working, but it is one product on one plate across several sales orders —
// physically a Single, and the one run that never splits. Classifying by
// gang_run_id rather than by KIND is what made the queue file it under Gang.
//
// Print Planning maps the same four words onto card-level FACTS instead
// (press hold + run kind) — see cardSetType in lib/setType.js; the vocabulary
// and the chip stay identical either way.
import { Link2, PauseCircle, Square, Stamp, ChevronDown } from 'lucide-react';

// New Output = this job needs a fresh plate set made; it cannot simply run on
// an existing output number the way a repeat does. It sits beside Single
// rather than inside it because the two piles are worked by different people
// on different days — plate-making has to happen before the job is schedulable
// at all.
export const SET_TYPE_META = {
  single:     { label: 'Single',     icon: Square,      chip: 'border-slate-200 bg-slate-50 text-slate-600' },
  gang:       { label: 'Gang',       icon: Link2,       chip: 'border-violet-200 bg-violet-50 text-violet-700' },
  new_output: { label: 'New Output', icon: Stamp,       chip: 'border-sky-200 bg-sky-50 text-sky-700' },
  hold:       { label: 'Hold',       icon: PauseCircle, chip: 'border-amber-200 bg-amber-50 text-amber-700' },
};

// The pure rules live in lib/setType.js so a node test can execute them — this
// file holds JSX and cannot be imported by one, so the rule that decides what
// the plant sees had only ever been grepped. Re-exported here so every
// existing `from '../components/SetType.jsx'` import keeps working unchanged.
export { rowSetType, holdReasonOf, cardSetType, isGangRun, isMergeRun } from '../lib/setType.js';

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
