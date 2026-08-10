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

// The newest of a set of timestamps. db.js overrides only the numeric parsers, so a
// timestamptz arrives as a JS Date — and a bare `.sort()` stringifies its arguments.
// Date.toString() begins with the WEEKDAY, so sorting Dates that way ranks them
// "Fri, Mon, Sat, Sun, Thu, Tue, Wed" and reports whichever plate happens to fall
// latest in the alphabet as the most recently used.
export function latestTimestamp(values = []) {
  const times = (Array.isArray(values) ? values : [])
    .filter(Boolean)
    .map(value => (value instanceof Date ? value : new Date(value)))
    .filter(date => !Number.isNaN(date.getTime()));
  if (!times.length) return null;
  return times.reduce((latest, date) => (date > latest ? date : latest));
}

// What was physically issued to the press, folded into the colour-and-quantity shape
// an operator reads — "Cyan × 2" — while the rows underneath stay one per plate. The
// press counts colours; the database counts plates; this is the bridge.
export function issuedPlateSummary(assets = []) {
  const rows = Array.isArray(assets) ? assets : [];
  const groups = new Map();
  for (const asset of rows) {
    const key = plateComponentKey(asset);
    const current = groups.get(key) || {
      key,
      component_type: asset.component_type,
      component_label: asset.component_label,
      pantone_code: asset.pantone_code || null,
      qty: 0,
      asset_ids: [],
    };
    current.qty += 1;
    current.asset_ids.push(asset.id);
    groups.set(key, current);
  }
  return { total: rows.length, breakup: [...groups.values()] };
}

// One spelling of "these returned plates are the same set". The returns queue groups
// by it and verify-return locks its peer group by it; when the two drifted apart the
// queue could show one card and the click could act on another.
export function plateReturnSetKey(row = {}) {
  return [
    row.tooling_request_id || '',
    row.job_card_id || '',
    row.source_grn_id || '',
    row.product_id,
    row.output_number || '',
    row.artwork_version || '',
    row.plate_master_id,
    // Condition is part of the identity: the warehouse decision is set-level, so
    // without this a single "Move to Used Rack" would sweep up the damaged plate
    // the operator had just flagged.
    row.condition || '',
  ].join('|');
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

// What the press may say about a plate it is handing back. Scrapped and Lost are
// deliberately absent: those are outcomes the warehouse reaches after physical
// inspection, and offering them here would let the press skip that gate.
export const PLATE_RETURN_CONDITIONS = ['Good', 'Fair', 'Damaged'];

// The plant's controlled sizes, in reading order. 600 x 730 leads because it is the
// main offset size; 560 x 670 is the metallic one and always the second question.
export const PLATE_SIZES_IN_ORDER = ['600 x 730', '560 x 670'];

// What a rack holds, counted in PHYSICAL PLATES rather than sets — a warehouse row is
// a set of four, and "4" on a KPI card has to mean four plates, not four sets.
// Undated plates are counted in the total but cannot be averaged, so they neither
// inflate nor deflate the age.
export function plateRackSummary(sets = [], today = new Date()) {
  const rows = Array.isArray(sets) ? sets : [];
  const bySize = new Map(PLATE_SIZES_IN_ORDER.map(size => [size, 0]));
  let total = 0;
  const ages = [];
  // Wear and shelf age answer different questions and can disagree completely: two
  // plates cut on the same day, one with eleven runs and one with none, are the same
  // AGE and nothing like the same plate. The rack reports both.
  const runs = [];
  const day = 24 * 60 * 60 * 1000;
  for (const set of rows) {
    const size = plateSizeOf(set) || set.plate_size || 'Other';
    const plates = set.components?.length ? set.components : [set];
    bySize.set(size, (bySize.get(size) || 0) + plates.length);
    total += plates.length;
    for (const plate of plates) {
      // use_count is NOT NULL DEFAULT 0, so a missing value means never run — it
      // belongs in the average as a zero, not skipped like an unknown date.
      runs.push(Math.max(0, Number(plate.use_count) || 0));
      const created = plate.plate_created_on || set.plate_created_on;
      if (!created) continue;
      const days = Math.round((today - new Date(created)) / day);
      if (Number.isFinite(days)) ages.push(Math.max(0, days));
    }
  }
  const mean = list => (list.length ? Math.round(list.reduce((sum, n) => sum + n, 0) / list.length) : 0);
  return {
    total,
    avg_age_days: mean(ages),
    avg_runs: mean(runs),
    by_size: [...bySize.entries()].map(([plate_size, plates]) => ({ plate_size, plates })),
  };
}

// "Are these plates on the rack, and free to take?" — nothing more. Two callers ask
// it for opposite purposes (retiring plates to scrap, and issuing them to a job), so
// it is named for the QUESTION rather than for either answer. It was previously
// called validatePlateRetirement and issuing borrowed it, which meant a route that
// hands plates OUT read as if it were throwing them away.
//
// The reason/note a caller records is its own business and is deliberately not a
// parameter here: retiring keeps it optional, issuing has no reason at all.
export function pickAvailableRackPlates({ rackAssets = [], assetIds = [] } = {}) {
  const wanted = [...new Set((Array.isArray(assetIds) ? assetIds : []).map(Number))].filter(Boolean);
  if (!wanted.length) {
    // Neutral wording: each caller words its own version of this before it gets here.
    throw Object.assign(new Error('Tick at least one plate'), { status: 400 });
  }
  const byId = new Map((Array.isArray(rackAssets) ? rackAssets : []).map(row => [Number(row.id), row]));
  const stranger = wanted.find(id => !byId.has(id));
  if (stranger) {
    throw Object.assign(new Error(`Plate ${stranger} is not in this rack`), { status: 409 });
  }
  const busy = wanted.map(id => byId.get(id)).find(row => row.status !== 'available');
  if (busy) {
    throw Object.assign(
      new Error(`${busy.component_label || busy.asset_number || `Plate ${busy.id}`} is not available — it is ${busy.status.replace(/_/g, ' ')}`),
      { status: 409 },
    );
  }
  return wanted.map(id => byId.get(id));
}


// What the warehouse may do with a plate handed back from the press. Two outcomes,
// decided per PLATE rather than per set: three plates of a set can be fit to run
// again while the fourth is finished, which is the whole reason the database keeps
// one row per physical plate.
export const RETURN_VERIFICATION_ACTIONS = ['verified_ok', 'scrap'];

export function validateReturnVerification({ components = [], decisions = [] } = {}) {
  const plates = (Array.isArray(components) ? components : [])
    .map(row => ({ ...row, asset_id: Number(row.asset_id ?? row.id) }))
    .filter(row => row.asset_id);
  if (!plates.length) {
    throw Object.assign(new Error('There are no returned plates to verify'), { status: 409 });
  }
  const byAsset = new Map();
  for (const row of (Array.isArray(decisions) ? decisions : [])) {
    byAsset.set(Number(row.asset_id), row);
  }
  const known = new Set(plates.map(row => row.asset_id));
  const stranger = [...byAsset.keys()].find(id => !known.has(id));
  if (stranger) {
    throw Object.assign(
      new Error(`Plate ${stranger} is not part of this return`),
      { status: 409 },
    );
  }
  const undecided = plates.filter(row => !byAsset.has(row.asset_id));
  if (undecided.length) {
    const names = undecided.map(row => row.component_label || row.asset_number || row.asset_id);
    throw Object.assign(
      new Error(`Decide every plate before verifying — still open: ${names.join(', ')}`),
      { status: 400 },
    );
  }
  return plates.map(row => {
    const action = String(byAsset.get(row.asset_id).action || '');
    if (!RETURN_VERIFICATION_ACTIONS.includes(action)) {
      const name = row.component_label || row.asset_number || `plate ${row.asset_id}`;
      throw Object.assign(
        new Error(`${name}: choose Used Plates Rack or Scrap`),
        { status: 400 },
      );
    }
    return { asset_id: row.asset_id, action, plate: row };
  });
}

// Why a plate is being replaced mid-run. Press-side causes only — this is the
// operator's account of what the machine did to it, not a warehouse grading.
export const PLATE_REPLACEMENT_REASONS = [
  'Damaged on machine',
  'Scratched or scored',
  'Poor register',
  'Image worn (dot loss)',
  'Wrong artwork version',
  'Other',
];

// A replacement is raised against plates the press is physically holding, so the
// selection is checked against what is actually issued rather than trusted from
// the form — a stale tab would otherwise scrap a plate on somebody else's job.
export function validatePlateReplacementRequest({ issuedAssets = [], assetIds = [], reason = '', note = '' } = {}) {
  const wanted = [...new Set((Array.isArray(assetIds) ? assetIds : []).map(Number))].filter(Boolean);
  if (!wanted.length) {
    throw Object.assign(new Error('Choose at least one plate to replace'), { status: 400 });
  }
  const issued = new Map((Array.isArray(issuedAssets) ? issuedAssets : []).map(row => [Number(row.id), row]));
  const stranger = wanted.find(id => !issued.has(id));
  if (stranger) {
    throw Object.assign(
      new Error(`Plate ${stranger} is not issued to this job`),
      { status: 409 },
    );
  }
  const picked = clean(reason);
  if (!PLATE_REPLACEMENT_REASONS.includes(picked)) {
    throw Object.assign(
      new Error('Choose a reason for the replacement'),
      { status: 400 },
    );
  }
  if (picked === 'Other' && !clean(note)) {
    throw Object.assign(
      new Error('Reason "Other" — say what happened to the plate'),
      { status: 400 },
    );
  }
  return wanted.map(id => issued.get(id));
}

export function validatePlateDispositions(assets = [], dispositions = []) {
  const issuedAssets = Array.isArray(assets) ? assets : [];
  const submittedDispositions = Array.isArray(dispositions) ? dispositions : [];
  if (!issuedAssets.length) return [];
  // Three ways to account for an issued plate: it came back (and is graded), it was
  // finished on the press and goes straight to scrap, or nobody can find it.
  //
  // NOTE: 'scrap' here retires a plate WITHOUT the warehouse's physical inspection,
  // which every other route in this module insists on. It exists because the press
  // is the last party to hold the plate and a plate it has destroyed is not worth
  // queueing for someone to look at. Nothing else may reach this path.
  const allowed = new Set(['return', 'lost', 'scrap']);
  const byAsset = new Map(submittedDispositions.map(row => [Number(row.asset_id), row]));
  // SOFT on absence, strict on content. Completing a printing job must never be
  // refused over plates — a press that has finished its run has finished it, and a
  // locked Complete button just means the count goes unrecorded instead. So a plate
  // the operator said nothing about is simply not moved; one he DID speak for is
  // validated properly, because a wrong record is worse than no record.
  return issuedAssets.filter(asset => allowed.has(byAsset.get(Number(asset.id))?.action)).map(asset => {
    const submitted = byAsset.get(Number(asset.id)) || {};
    const name = asset.component_label || asset.asset_number || `plate ${asset.id}`;
    const note = clean(submitted.note) || null;
    if (submitted.action === 'scrap') {
      // Not a grading — the plate is finished. The operator's remark, if he left
      // one, is the only account of why.
      return { ...submitted, asset, condition: 'Scrapped', note };
    }
    if (submitted.action === 'lost') {
      // No condition to declare — nobody has the plate to look at. The dropdown
      // choice is itself the reason, so the note stays optional; demanding a second
      // statement of the same fact only holds up the end of a run.
      return { ...submitted, asset, condition: 'Lost', note };
    }
    // An older caller that sends no condition is stating the ordinary case, not
    // omitting a decision — the plate came back as it went out.
    const condition = submitted.condition == null ? 'Good' : String(submitted.condition);
    if (!PLATE_RETURN_CONDITIONS.includes(condition)) {
      throw Object.assign(
        new Error(`${name}: a returned plate must be Good, Fair or Damaged`),
        { status: 400 },
      );
    }
    // The condition itself is the declaration. A note adds colour for the warehouse
    // when the operator has something to add, and is never a gate.
    return { ...submitted, asset, condition, note };
  });
}
