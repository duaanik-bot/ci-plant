// What a plate line IS — one spelling, shared by every screen that shows one.
//
// This vocabulary lived inside PlatesLifecycle.jsx, private to it. So the three
// other surfaces that show a plate PO line could not reach it, and each said
// less than the one before: the PO edit modal fell through to `Line 42`, the
// register dropped the inks, and POPrint — the document that leaves the
// building — printed the generic inventory name, "Plate 1030x800", to a vendor
// who then has to guess which artwork and which colours.
//
// A plate line's identity is four things in this order:
//
//   1. the product        (a gang names itself, and lists its members)
//   2. PR · JC            (which paperwork raised it)
//   3. Output · size      (what the plant and the vendor both call it by)
//   4. the inks           (what is actually on the plates)
//
// Any screen that shows fewer than four is a screen where somebody has to ask.
//
// The arithmetic behind all of that lives in lib/plateInks.js — `.jsx` cannot be
// run under `node --test`, and those rules are exactly the ones worth pinning.
// It is re-exported here so a screen has one import, not two.

import { fmt } from '../api.js';
import ProductIdentity from './ProductIdentity.jsx';
import {
  PROCESS_PLATES, SHORT_COMPONENT, shortComponent, componentKey, groupedComponents,
  inkOrder, inkSummary, inkSummaryByStatus, componentTickLabel, gangMemberNames,
  plateLineRefs, plateLineSpec, plateLinePrintSpec,
  DRIPOFF_TYPE, DRIPOFF_LABEL, DRIP_OFF_PLATE_SIZE, isDripOff, hasDripOffCoating,
} from '../lib/plateInks.js';

export {
  PROCESS_PLATES, SHORT_COMPONENT, shortComponent, componentKey, groupedComponents,
  inkOrder, inkSummary, inkSummaryByStatus, componentTickLabel, gangMemberNames,
  plateLineRefs, plateLineSpec, plateLinePrintSpec,
  DRIPOFF_TYPE, DRIPOFF_LABEL, DRIP_OFF_PLATE_SIZE, isDripOff, hasDripOffCoating,
};

export const PLATE_TONE = {
  verification_required: 'bg-amber-50 text-amber-700',
  existing_plate_check: 'bg-slate-100 text-slate-600',
  verified_existing: 'bg-emerald-50 text-emerald-700',
  pr_required: 'bg-orange-50 text-orange-700',
  replacement_required: 'bg-red-50 text-red-700',
  approved: 'bg-blue-50 text-blue-700',
  po_created: 'bg-cyan-50 text-cyan-700',
  ordered: 'bg-cyan-50 text-cyan-700',
  grn_received: 'bg-emerald-50 text-emerald-700',
  available: 'bg-emerald-50 text-emerald-700',
  reserved: 'bg-emerald-50 text-emerald-700',
  issued: 'bg-violet-50 text-violet-700',
  issued_to_coating: 'bg-violet-50 text-violet-700',
  returned_pending_verification: 'bg-amber-50 text-amber-700',
  damaged: 'bg-red-50 text-red-700',
  scrapped: 'bg-slate-200 text-slate-600',
  ready: 'bg-emerald-50 text-emerald-700',
  procurement: 'bg-blue-50 text-blue-700',
  rack_reserved: 'bg-emerald-50 text-emerald-700',
  draft: 'bg-slate-100 text-slate-600',
  saved: 'bg-amber-50 text-amber-700',
  converted: 'bg-blue-50 text-blue-700',
  reversed: 'bg-red-50 text-red-700',
  pending: 'bg-slate-100 text-slate-600',
  available_asset: 'bg-emerald-50 text-emerald-700',
  mixed: 'bg-slate-100 text-slate-600',
};

export const plateStatusLabel = value => ({
  draft: 'Draft', saved: 'Saved', approved: 'Approved', converted: 'PO created',
  verification_required: 'Verify rack', verified_existing: 'Existing & verified',
  pr_required: 'PR required', replacement_required: 'Replacement required',
  po_created: 'PO raised', grn_received: 'GRN received',
  returned_pending_verification: 'Verify return', issued_to_printing: 'Issued to printing',
  issued_to_coating: 'Issued to coating',
  reversed: 'Reversed', mixed: 'Mixed status',
}[value] || fmt.title(value || 'pending'));

export function PlateStatusChip({ value }) {
  return <span className={`inline-flex whitespace-nowrap rounded-full px-2 py-1 text-[10px] font-bold ${PLATE_TONE[value] || 'bg-slate-100 text-slate-600'}`}>{plateStatusLabel(value)}</span>;
}

const DOT = status => (['verified_existing', 'available', 'reserved', 'issued'].includes(status) ? 'bg-emerald-500'
  : status === 'verification_required' ? 'bg-amber-500'
    : status === 'scrapped' ? 'bg-slate-400' : 'bg-blue-500');

// Every plate, named. For a picking list, where the roll-call IS the point.
export function ComponentStrip({ components = [], compact = false }) {
  return <div className={`flex flex-wrap ${compact ? 'gap-1' : 'gap-1.5'}`}>
    {inkOrder(groupedComponents(components)).map(component => <span key={component.key} title={plateStatusLabel(component.status)}
      className={`inline-flex items-center gap-1 rounded-full px-2 py-1 ${compact ? 'text-[9px]' : 'text-[10px]'} font-bold ${PLATE_TONE[component.status] || 'bg-slate-100 text-slate-600'}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${DOT(component.status)}`} />
      {component.component_label}{component.qty > 1 ? ` x${component.qty}` : ''}
    </span>)}
  </div>;
}

// The build, in one or two chips. For a dense list, where nineteen sets each
// spelling out Cyan · Magenta · Yellow · Black is noise rather than information.
export function InkSummary({ components = [] }) {
  const parts = inkSummary(components);
  if (!parts.length) return null;
  return <span className="flex shrink-0 flex-wrap items-center gap-1">
    {parts.map(part => <span key={part.key} title={part.title}
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-1.5 py-0.5 text-[9px] font-bold ${PLATE_TONE[part.status] || 'bg-slate-100 text-slate-600'}`}>
      <span className={`h-1 w-1 rounded-full ${DOT(part.status)}`} />
      {part.label}
    </span>)}
  </span>;
}

// The build once per STATE, for a requirement — where the colours genuinely
// differ and which ones differ is the question. A set that is wholly one state
// renders exactly one chip, same as InkSummary.
export function InkStateSummary({ components = [] }) {
  const parts = inkSummaryByStatus(components);
  if (!parts.length) return null;
  return <span className="flex flex-wrap items-center gap-1">
    {parts.map(part => <span key={part.status} title={`${plateStatusLabel(part.status)} — ${part.title}`}
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-1.5 py-0.5 text-[9px] font-bold ${PLATE_TONE[part.status] || 'bg-slate-100 text-slate-600'}`}>
      <span className={`h-1 w-1 rounded-full ${DOT(part.status)}`} />
      {part.label}
    </span>)}
  </span>;
}

export function PlateProductIdentity({ row, compact = false }) {
  if (!row?.is_gang) return <ProductIdentity row={row} compact={compact} />;
  const members = Array.isArray(row.gang_members) ? row.gang_members : [];
  const names = gangMemberNames(row);
  return <div className="min-w-0">
    <b className={`block truncate text-slate-800 ${compact ? 'text-xs' : 'text-sm'}`}>{row.product_name || row.gang_number || 'Gang Plate'}</b>
    <span className="block truncate text-[11px] text-slate-500">Unified gang plate · {members.length || 'Multiple'} products</span>
    {names && <span className="block max-w-[340px] truncate text-[10px] text-slate-400" title={names}>{names}</span>}
  </div>;
}

// The full four-part identity. `compact` tightens it for a table cell.
//
// `inks` is three-way on purpose: `true` names every plate (a picking list — the
// roll-call IS the point), `'summary'` gives the build (a dense list, where
// nineteen sets spelling out CMYK is noise), `false` turns it off where the strip
// is rendered separately.
export function PlateLineIdentity({ line, compact = false, inks = true }) {
  const refs = plateLineRefs(line);
  const spec = plateLineSpec(line);
  const hasInks = (line.components || []).length > 0;
  return <div className="min-w-0 space-y-1">
    <PlateProductIdentity row={line} compact={compact} />
    {refs && <span className="block truncate text-[11px] text-slate-400">{refs}</span>}
    {spec && <span className="block truncate font-mono text-[11px] font-semibold text-slate-600">{spec}</span>}
    {hasInks && inks === 'summary' && <InkSummary components={line.components} />}
    {hasInks && inks === true && <ComponentStrip components={line.components} compact />}
  </div>;
}
