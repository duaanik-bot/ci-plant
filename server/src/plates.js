import { derivedCounts } from './print-colour.js';

const PROCESS_COMPONENTS = [
  ['cyan', 'Cyan'],
  ['magenta', 'Magenta'],
  ['yellow', 'Yellow'],
  ['black', 'Black'],
];

const clean = value => String(value ?? '').trim();
const PROCESS_LABELS = Object.fromEntries(PROCESS_COMPONENTS);

export const FRESH_PLATES_RACK = 'Fresh Plates Rack';
export const USED_PLATES_RACK = 'Used Plates Rack';
export const PLATE_RETURN_QUEUE = 'Plate Return Queue';

export function splitPlateColours(value) {
  return clean(value)
    .split(/[,;\n/]+/)
    .map(part => part.trim())
    .filter(Boolean);
}

export function artworkVersionOf(spec = {}) {
  return clean(spec.artwork_version)
    || clean(spec.party_artwork_code)
    || clean(spec.output_number)
    || 'Unversioned';
}

export function plateSizeOf(spec = {}) {
  const raw = clean(spec.plate_size || spec.sheet_size).replace(/[×X]/g, 'x');
  const match = raw.match(/(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)/i);
  return match ? `${match[1]} x ${match[2]}` : null;
}

export function defaultPlateSize(spec = {}, components = []) {
  const metallic = Number(spec.metallic_colours) > 0
    || /metallic/i.test(clean(spec.metallic_details))
    || /metallic/i.test(clean(spec.colour_type))
    || /metallic/i.test(clean(spec.print_process))
    || components.some(component => /^metallic\s*-/i.test(clean(component.component_label)));
  return metallic ? '560 x 670' : '600 x 730';
}

export function resolvePlateRate(rates = [], plateMasterId, vendorId = null, onDate = new Date()) {
  const masterId = Number(plateMasterId);
  const wantedVendor = vendorId == null || vendorId === '' ? null : Number(vendorId);
  const date = typeof onDate === 'string' ? onDate.slice(0, 10) : onDate.toISOString().slice(0, 10);
  const candidates = rates.filter(row => Number(row.plate_master_id) === masterId
    && Number(row.active) === 1
    && (!row.effective_from || String(row.effective_from).slice(0, 10) <= date)
    && (row.vendor_id == null || Number(row.vendor_id) === wantedVendor));
  candidates.sort((a, b) => {
    const aSpecific = a.vendor_id != null && Number(a.vendor_id) === wantedVendor ? 1 : 0;
    const bSpecific = b.vendor_id != null && Number(b.vendor_id) === wantedVendor ? 1 : 0;
    if (aSpecific !== bSpecific) return bSpecific - aSpecific;
    const byDate = String(b.effective_from || '').localeCompare(String(a.effective_from || ''));
    return byDate || Number(b.id) - Number(a.id);
  });
  return candidates[0] || null;
}

function namedComponents({ count, names, prefix }) {
  const out = [];
  for (let index = 0; index < count; index += 1) {
    const identity = names[index] || `${prefix} ${index + 1}`;
    out.push({
      component_type: 'pantone',
      component_label: `${prefix} - ${identity}`,
      pantone_code: identity,
    });
  }
  return out;
}

// UI may group these rows as one Plate Set. The database never does: every
// physical plate is one component so 3 reusable + 1 replacement remains valid.
export function plateComponentsFromSpec(spec = {}) {
  const counts = derivedCounts(spec);
  const processCount = Math.max(0, Math.min(4, Number(counts.cmyk) || 0));
  const components = PROCESS_COMPONENTS.slice(0, processCount).map(([component_type, component_label]) => ({
    component_type,
    component_label,
    pantone_code: null,
  }));

  const pantoneNames = splitPlateColours(spec.pantone_codes);
  components.push(...namedComponents({
    count: Math.max(0, Number(counts.pantone) || 0),
    names: pantoneNames,
    prefix: 'Pantone',
  }));

  const metallicNames = splitPlateColours(spec.metallic_details);
  components.push(...namedComponents({
    count: Math.max(0, Number(counts.metallic) || 0),
    names: metallicNames,
    prefix: 'Metallic',
  }));

  // Some old products only have a total count. Preserve the physical demand
  // even when the master has not yet named every spot colour.
  const expected = Math.max(0, Number(counts.total) || components.length);
  while (components.length < expected) {
    const number = components.filter(row => row.component_type === 'pantone').length + 1;
    components.push({
      component_type: 'pantone',
      component_label: `Pantone - Pantone ${number}`,
      pantone_code: `Pantone ${number}`,
    });
  }
  return components.map((component, index) => ({ ...component, sequence_no: index + 1 }));
}

export function plateComponentKey(component = {}) {
  const type = clean(component.component_type).toLowerCase();
  const identity = type === 'pantone'
    ? clean(component.pantone_code || component.component_label).toLowerCase()
    : '';
  return `${type}|${identity}`;
}

// The database keeps one row per physical plate. This folds those records into
// the colour + quantity model used by the editor and PO confirmation without
// losing the IDs and statuses needed for individual lifecycle tracking.
export function plateQuantityBreakdown(components = []) {
  const groups = new Map();
  for (const component of components.filter(row => row.status !== 'cancelled')) {
    const key = plateComponentKey(component);
    const current = groups.get(key) || {
      key,
      component_type: component.component_type,
      component_label: component.component_label,
      pantone_code: component.pantone_code || null,
      qty: 0,
      component_ids: [],
      statuses: [],
    };
    current.qty += 1;
    current.component_ids.push(component.id);
    current.statuses.push(component.status);
    groups.set(key, current);
  }
  return [...groups.values()];
}

// Expand an editable quantity model back into one row per physical plate. CMYK
// labels are controlled; each Pantone keeps its own exact identity.
export function expandPlateQuantities(entries = []) {
  const expanded = [];
  for (const entry of entries) {
    const componentType = clean(entry.component_type).toLowerCase();
    if (!PROCESS_LABELS[componentType] && componentType !== 'pantone') {
      throw Object.assign(new Error(`Unknown plate colour/type: ${entry.component_type || 'blank'}`), { status: 400 });
    }
    const rawQty = Number(entry.qty);
    if (!Number.isInteger(rawQty) || rawQty < 0 || rawQty > 99) {
      throw Object.assign(new Error(`${PROCESS_LABELS[componentType] || 'Pantone'} quantity must be a whole number from 0 to 99`), { status: 400 });
    }
    if (rawQty === 0) continue;
    const identity = componentType === 'pantone'
      ? clean(entry.pantone_code || entry.component_label).replace(/^(Pantone|Metallic)\s*-\s*/i, '')
      : '';
    if (componentType === 'pantone' && !identity) {
      throw Object.assign(new Error('Every Pantone plate needs its Pantone number or name'), { status: 400 });
    }
    const prefix = /^Metallic\s*-/i.test(clean(entry.component_label)) ? 'Metallic' : 'Pantone';
    const componentLabel = componentType === 'pantone'
      ? `${prefix} - ${identity}`
      : PROCESS_LABELS[componentType];
    for (let index = 0; index < rawQty; index += 1) {
      expanded.push({
        component_type: componentType,
        component_label: componentLabel,
        pantone_code: componentType === 'pantone' ? identity : null,
        sequence_no: expanded.length + 1,
      });
    }
  }
  if (!expanded.length) {
    throw Object.assign(new Error('A Plate Requirement needs at least one plate'), { status: 400 });
  }
  return expanded;
}

export function plateComponentStatus(status) {
  if (['verified_existing', 'available', 'reserved', 'issued'].includes(status)) return 'ready';
  if (['damaged', 'scrapped', 'not_found', 'replacement_required'].includes(status)) return 'attention';
  return 'pending';
}

export function plateReadinessSummary(components = []) {
  const active = components.filter(component => component.status !== 'cancelled');
  const ready = active.filter(component => plateComponentStatus(component.status) === 'ready').length;
  return {
    required: active.length,
    ready,
    pending: active.length - ready,
    is_ready: active.length > 0 && ready === active.length,
  };
}

export function validatePlateDispositions(assets = [], dispositions = []) {
  const issuedAssets = Array.isArray(assets) ? assets : [];
  const submittedDispositions = Array.isArray(dispositions) ? dispositions : [];
  if (!issuedAssets.length) return [];
  const allowed = new Set(['return']);
  const byAsset = new Map(submittedDispositions.map(row => [Number(row.asset_id), row]));
  const missing = issuedAssets.filter(asset => !allowed.has(byAsset.get(Number(asset.id))?.action));
  if (missing.length) {
    const error = new Error(`Return all ${issuedAssets.length} issued plates before completing printing`);
    error.status = 400;
    throw error;
  }
  return issuedAssets.map(asset => ({ asset, ...byAsset.get(Number(asset.id)) }));
}
