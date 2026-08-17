// What a plate line IS — one spelling, shared by every screen that shows one.
//
// This vocabulary lived inside PlatesLifecycle.jsx, private to it. So the three
// other surfaces that show a plate PO line could not reach it, and each said
// less than the one before: the PO edit modal fell through to `Line 42`, the
// register row dropped the inks, and POPrint — the document that leaves the
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

import { fmt } from '../api.js';
import ProductIdentity from './ProductIdentity.jsx';

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
};

export const plateStatusLabel = value => ({
  draft: 'Draft', saved: 'Saved', approved: 'Approved', converted: 'PO created',
  verification_required: 'Verify rack', verified_existing: 'Existing & verified',
  pr_required: 'PR required', replacement_required: 'Replacement required',
  po_created: 'PO raised', grn_received: 'GRN received',
  returned_pending_verification: 'Verify return', issued_to_printing: 'Issued to printing',
  reversed: 'Reversed', mixed: 'Mixed status',
}[value] || fmt.title(value || 'pending'));

export function PlateStatusChip({ value }) {
  return <span className={`inline-flex whitespace-nowrap rounded-full px-2 py-1 text-[10px] font-bold ${PLATE_TONE[value] || 'bg-slate-100 text-slate-600'}`}>{plateStatusLabel(value)}</span>;
}

export const PROCESS_PLATES = [
  ['cyan', 'Cyan'], ['magenta', 'Magenta'], ['yellow', 'Yellow'], ['black', 'Black'],
];

// A spot plate is identified by its Pantone, a process plate by its type. Two
// PMS 485C rows are the same plate twice; Cyan and Magenta never merge.
export const componentKey = component => `${component.component_type}|${component.component_type === 'pantone'
  ? String(component.pantone_code || component.component_label || '').trim().toLowerCase() : ''}`;

export function groupedComponents(components = []) {
  const groups = new Map();
  for (const component of components.filter(row => row.status !== 'cancelled')) {
    const key = componentKey(component);
    const group = groups.get(key) || {
      key, component_type: component.component_type, component_label: component.component_label,
      pantone_code: component.pantone_code || null, qty: 0, component_ids: [], statuses: [],
      // The rack plates this colour is actually HOLDING. Needed by Retire, which
      // acts on the asset rather than on the requirement line.
      asset_ids: [],
    };
    group.qty += 1; group.component_ids.push(component.id); group.statuses.push(component.status);
    if (component.matched_asset_id) group.asset_ids.push(Number(component.matched_asset_id));
    groups.set(key, group);
  }
  return [...groups.values()].map(group => ({
    ...group,
    status: group.statuses.every(value => value === group.statuses[0]) ? group.statuses[0] : 'mixed',
  }));
}

// CMYK in press order, then spot colours alphabetically. A vendor reading a PO
// and a warehouse ticking a delivery both expect the process set first and in
// the order the press lays it down — not in whatever order the rows were keyed.
const INK_RANK = new Map(PROCESS_PLATES.map(([type], index) => [type, index]));
export function inkOrder(rows = []) {
  return [...rows].sort((a, b) => {
    const left = INK_RANK.has(a.component_type) ? INK_RANK.get(a.component_type) : 99;
    const right = INK_RANK.has(b.component_type) ? INK_RANK.get(b.component_type) : 99;
    if (left !== right) return left - right;
    return String(a.component_label || '').localeCompare(String(b.component_label || ''));
  });
}

const DOT = status => (['verified_existing', 'available', 'reserved', 'issued'].includes(status) ? 'bg-emerald-500'
  : status === 'verification_required' ? 'bg-amber-500'
    : status === 'scrapped' ? 'bg-slate-400' : 'bg-blue-500');

export function ComponentStrip({ components = [], compact = false }) {
  return <div className={`flex flex-wrap ${compact ? 'gap-1' : 'gap-1.5'}`}>
    {inkOrder(groupedComponents(components)).map(component => <span key={component.key} title={plateStatusLabel(component.status)}
      className={`inline-flex items-center gap-1 rounded-full px-2 py-1 ${compact ? 'text-[9px]' : 'text-[10px]'} font-bold ${PLATE_TONE[component.status] || 'bg-slate-100 text-slate-600'}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${DOT(component.status)}`} />
      {component.component_label}{component.qty > 1 ? ` x${component.qty}` : ''}
    </span>)}
  </div>;
}

export function PlateProductIdentity({ row, compact = false }) {
  if (!row?.is_gang) return <ProductIdentity row={row} compact={compact} />;
  const members = Array.isArray(row.gang_members) ? row.gang_members : [];
  return <div className="min-w-0">
    <b className={`block truncate text-slate-800 ${compact ? 'text-xs' : 'text-sm'}`}>{row.product_name || row.gang_number || 'Gang Plate'}</b>
    <span className="block truncate text-[11px] text-slate-500">Unified gang plate · {members.length || 'Multiple'} products</span>
    {members.length > 0 && <span className="block max-w-[340px] truncate text-[10px] text-slate-400"
      title={members.map(member => member.product_name).filter(Boolean).join(' · ')}>
      {members.map(member => member.product_name).filter(Boolean).join(' · ')}
    </span>}
  </div>;
}

// What to call one plate on a tick list. A spot plate's Pantone is the thing
// that identifies it — but plenty of labels already carry it ("Pantone -
// Pantone 1"), and appending it again reads as two different codes.
export function componentTickLabel(component) {
  const label = String(component?.component_label || '').trim();
  const code = String(component?.pantone_code || '').trim();
  if (!code || label.toLowerCase().includes(code.toLowerCase())) return label || code;
  return `${label} (${code})`;
}

// The paperwork line: which PR raised it, on which job card.
export const plateLineRefs = line => [line?.request_number, line?.jc_number].filter(Boolean).join(' · ');

// The spec line: what the plant and the vendor call this plate by. Output first
// because that is the number spoken on the floor; the size is what the rack is
// physically organised around.
export const plateLineSpec = line => [
  line?.output_number ? `Output ${line.output_number}` : null,
  line?.plate_size || null,
].filter(Boolean).join(' · ');

// The full four-part identity. `compact` tightens it for a table cell; `inks`
// can be turned off where the strip is rendered separately.
export function PlateLineIdentity({ line, compact = false, inks = true }) {
  const refs = plateLineRefs(line);
  const spec = plateLineSpec(line);
  return <div className="min-w-0 space-y-1">
    <PlateProductIdentity row={line} compact={compact} />
    {refs && <span className="block truncate text-[11px] text-slate-400">{refs}</span>}
    {spec && <span className="block truncate font-mono text-[11px] font-semibold text-slate-600">{spec}</span>}
    {inks && (line.components || []).length > 0 && <ComponentStrip components={line.components} compact />}
  </div>;
}

// The same identity as flat text, for the printed PO. A vendor document has no
// chips and no colour — it needs the words on the page.
export function plateLinePrintSpec(line) {
  const inks = inkOrder(groupedComponents(line?.components || []))
    .map(row => `${row.component_label}${row.qty > 1 ? ` x${row.qty}` : ''}`);
  return {
    name: line?.product_name || null,
    refs: plateLineRefs(line),
    spec: plateLineSpec(line),
    inks: inks.join(' · '),
  };
}
