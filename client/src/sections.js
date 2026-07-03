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
