// One source of truth for production sections — order, labels, icons, tints.
// Mirrors the CI-Production 10-stage plant flow.
import {
  Scissors, Printer, Droplets, Layers, Sparkles, Stamp, Square,
  ListChecks, Combine, ShieldCheck,
} from 'lucide-react';

export const SECTION_META = {
  cutting: { label: 'Cutting', icon: Scissors, tint: 'text-slate-600 bg-slate-100', desc: 'Board cutting — parent sheets to press size, FIFO issue from stores' },
  printing: { label: 'Printing', icon: Printer, tint: 'text-sky-600 bg-sky-50', desc: 'Press floor — ink on sheet, queue set by Print Planning' },
  coating: { label: 'Coating', icon: Droplets, tint: 'text-cyan-600 bg-cyan-50', desc: 'Coating line — aqueous and UV varnish execution' },
  lamination: { label: 'Lamination', icon: Layers, tint: 'text-teal-600 bg-teal-50', desc: 'Thermal lamination — matt and gloss film' },
  foiling: { label: 'Foiling', icon: Sparkles, tint: 'text-amber-600 bg-amber-50', desc: 'Hot-foil stamping — leafing and metallic effects' },
  embossing: { label: 'Embossing', icon: Stamp, tint: 'text-orange-600 bg-orange-50', desc: 'Embossing press — raised and debossed impressions' },
  die_cutting: { label: 'Die Cutting', icon: Square, tint: 'text-rose-600 bg-rose-50', desc: 'Die cutting & blanking — sheets to carton blanks' },
  sorting: { label: 'Sorting', icon: ListChecks, tint: 'text-fuchsia-600 bg-fuchsia-50', desc: 'Blank sorting & NCR — count, inspect, reject with reason' },
  pasting: { label: 'Pasting', icon: Combine, tint: 'text-violet-600 bg-violet-50', desc: 'Folder-gluer — pasting, packing manifest to dispatch' },
  qc: { label: 'QC', icon: ShieldCheck, tint: 'text-emerald-600 bg-emerald-50', desc: 'Final quality inspection — batch release to finished goods' },
};

export const SECTION_ORDER = Object.keys(SECTION_META);

// Sorting and Pasting are consolidated into ONE operator station — "Sort &
// Paste". It is a merged UI station, NOT a DB stage (the ledger keeps sorting
// and pasting separate), so it lives outside SECTION_META / SECTION_ORDER to
// avoid leaking a phantom stage into the timeline, masters and enums.
export const SORT_PASTE_META = {
  key: 'sort_paste', label: 'Sort & Paste', icon: Combine,
  tint: 'text-violet-600 bg-violet-50',
  desc: 'Unified sorting & pasting — sorted-waste gate, then hybrid auto/manual pasting and packing',
  path: '/floor/sort-paste',
};

// Live Floor navigation order: the real stages, but with Sorting + Pasting
// collapsed into the single Sort & Paste station (placed where Sorting sat).
export const FLOOR_NAV = SECTION_ORDER.reduce((acc, key) => {
  if (key === 'sorting') { acc.push({ ...SORT_PASTE_META, countKeys: ['sorting', 'pasting'] }); return acc; }
  if (key === 'pasting') return acc; // merged into the entry above
  // QC inspection is consolidated into the "Finished Goods & QC" module, so it
  // no longer appears as a Live-Floor station (the qc DB stage still exists and
  // SECTION_META.qc is kept for stage rendering, timelines and history).
  if (key === 'qc') return acc;
  const m = SECTION_META[key];
  acc.push({ key, label: m.label, icon: m.icon, tint: m.tint, path: `/floor/${key}`, countKeys: [key] });
  return acc;
}, []);

// Per-row pasting methods on the hybrid grid.
// Order is the plant's, not the code's: machine, hand, then the two mixed ways
// of working. Simple before compound, so the two everyday answers sit first.
export const PASTING_METHODS = [
  { key: 'machine', label: 'Machine', hint: 'Fully pasted on an automated folder-gluer' },
  { key: 'manual', label: 'Hand', hint: 'Fully pasted by hand' },
  { key: 'machine_manual', label: 'Machine + hand', hint: 'Same pieces — machine side-pastes, hand locks' },
  { key: 'split', label: 'Split', hint: 'Some pieces by machine, the rest by hand' },
];

// Who normally stands at which bench. Prefilled, never enforced — the chip is
// still free to be changed or cleared, because the regular man is off sick often
// enough that a locked default would just get worked around.
//
// Matched on the machine NAME, not its id: ids differ between the plant database
// and any local copy, and the name is what the floor calls the machine anyway.
// The token is matched against the crew list so the chip resolves to the real
// employee record ("Dileep" → "Dileep Pasting"), and quietly yields nothing if
// that person has left.
export const DEFAULT_PASTER_BY_MACHINE = [
  { match: /lock\s*bottom/i, operator: 'Dileep' },
  { match: /side/i, operator: 'Shankar' },
];
export const DEFAULT_HAND_PASTER = 'Jieut';

// The sorting bench. Several men sort one job at once, so this is a multiple
// choice — recording only the first would credit one man with three men's work.
export const SORTERS = ['Manish', 'Saroj', 'Keshav'];

// Rejection/wastage reasons — sorting gets the CI-Production NCR list,
// other sections a shorter operational set.
export const SORTING_REJECTION_REASONS = [
  'Misprint', 'Die-cut error', 'Lamination defect', 'Foil misregister',
  'Crease break', 'Surface damage', 'Other',
];
export const GENERAL_WASTAGE_REASONS = [
  'Make-ready', 'Registration', 'Colour variation', 'Sheet damage', 'Machine fault', 'Other',
];
export const HOLD_REASONS = [
  'Machine breakdown', 'Shade approval awaited', 'Material issue', 'Power cut', 'Operator unavailable', 'Other',
];
// Why a job is parked in Planning's Hold zone. A different list from
// HOLD_REASONS above: that one answers "why did the PRESS stop" (machine,
// power, operator), this one answers "why has this not been planned yet" —
// the planner's reasons, not the floor's. 'Other' opens a free-text box, so
// the picklist can stay short without ever losing a reason.
export const PLANNING_HOLD_REASONS = [
  'Will plan later', 'Batch pending', 'Shade card pending', 'Hold by party', 'Other',
];
// The reason a freshly opened prompt starts on — the commonest answer by far,
// so the usual hold is one click. Any other reason is one pick away.
export const PLANNING_HOLD_DEFAULT = 'Will plan later';
export const CUTTING_VARIANCE_REASONS = [
  'Packet intact – full bundle cut', 'Board damaged', 'Extra for wastage buffer',
  'Short board / packet short', 'Miscount / recount', 'Other',
];

// Line clearance checklist — confirmed at every working station
// (cutting → pasting) before a run starts. QC is exempt.
export const LINE_CLEARANCE_ITEMS = [
  'Previous job’s sheets, blanks and cartons removed from the machine & delivery area',
  'Machine cleaned — no ink, glue, powder or dust residue from the last job',
  'Correct job card, approved sample / shade card present at the machine',
  'Material for THIS job verified against the job card (board, sheets, count)',
  'Tooling for THIS job loaded and checked (plates / die / stereos as applicable)',
  'Waste bin emptied — no mixed stock or loose sheets around the machine',
];
