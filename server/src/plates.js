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

// ── When are two spellings the same artwork? ──────────────────────────────
// Live plant data, 2026-08-12: of the ten open Plate PRs whose product HAS plates
// on the rack, eight read as having none. Not because the artwork differs — the
// requirement carries the plant's short revision ("R1") while the plate was
// labelled with its full artwork code and revision ("PCS-W026/R1"), or one side
// writes "PC402001" where the other writes "PC-402001". Compared character for
// character the Requirement page printed 8 reusable plates where the true figure
// was 41, and the plant kept buying plates it already owned.
//
// The comparison is deliberately NARROW, because putting a superseded artwork on
// a press is a customer reject:
//   • it only ever runs within one product_id, one colour and one Pantone —
//     product identity is an exact key and is never fuzzy-matched here;
//   • punctuation and case are ignored, and nothing else is;
//   • a bare revision token (R0, R1, R2…) may match the TRAILING revision of a
//     fuller label, and only that. R1 never accepts an R2 plate, and a code that
//     is not a revision token never matches a segment of another code.
export function plateArtworkKey(version) {
  return clean(version).replace(/[^A-Za-z0-9/]/g, '').toUpperCase();
}

// The last '/'-separated piece of a rack label: "PCS-W026/R1" -> "R1".
export function plateArtworkTrailingKey(version) {
  return plateArtworkKey(version).replace(/^.*\//, '');
}

// R0, R1, R2… and nothing else. 'Unversioned' — artworkVersionOf's fallback when
// a requirement names no artwork at all — is deliberately NOT one, or a job with
// no artwork recorded would claim every plate its product has ever had.
export function isBareArtworkRevision(version) {
  return /^R\d+$/.test(plateArtworkKey(version));
}

// The same two functions as SQL, so a comparison can be made inside a query
// against a column instead of only in JS against a value.
export const plateArtworkKeySql = expr => `upper(regexp_replace(${expr},'[^A-Za-z0-9/]','','g'))`;
export const plateArtworkIsRevisionSql = expr => `(${plateArtworkKeySql(expr)} ~ '^R[0-9]+$')`;

// ONE spelling of the comparison. Every side that asks it — bestPlateCandidate,
// which hands the plate out; the availability count, which promises it; and the
// older-artwork warning, which is its exact complement — builds its clause from
// this, so the column can never offer what the button refuses, nor a banner call
// "superseded" a plate the button is about to spend.
export function plateArtworkMatchSql(column, key, isRevision) {
  const canon = plateArtworkKeySql(column);
  return `(${canon}=${key}
    OR (${isRevision} AND regexp_replace(${canon},'^.*/','')=${key}))`;
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

// A calendar day as 'YYYY-MM-DD', from either a string or the JS Date the driver
// hands back. db.js overrides only the NUMERIC parsers, so a `date` column
// arrives as a Date at LOCAL midnight — and String(date) starts with the WEEKDAY
// ("Sat Aug 08…"), which compares as text far above "2026-…". That made every
// rate read as not-yet-effective, so no Plate PO could ever price itself.
//
// Local parts, never toISOString(): pg builds the Date at local midnight, so east
// of Greenwich the ISO form is the PREVIOUS day (2026-08-08 IST → 2026-08-07T18:30Z)
// and a rate would start applying a day early.
function dayOf(value) {
  if (!value) return null;
  if (value instanceof Date) {
    const pad = n => String(n).padStart(2, '0');
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  return String(value).slice(0, 10);
}

export function resolvePlateRate(rates = [], plateMasterId, vendorId = null, onDate = new Date()) {
  const masterId = Number(plateMasterId);
  const wantedVendor = vendorId == null || vendorId === '' ? null : Number(vendorId);
  const date = dayOf(onDate);
  const candidates = rates.filter(row => Number(row.plate_master_id) === masterId
    && Number(row.active) === 1
    && (!row.effective_from || dayOf(row.effective_from) <= date)
    && (row.vendor_id == null || Number(row.vendor_id) === wantedVendor));
  candidates.sort((a, b) => {
    const aSpecific = a.vendor_id != null && Number(a.vendor_id) === wantedVendor ? 1 : 0;
    const bSpecific = b.vendor_id != null && Number(b.vendor_id) === wantedVendor ? 1 : 0;
    if (aSpecific !== bSpecific) return bSpecific - aSpecific;
    // Same trap as the filter: a stringified Date sorts by WEEKDAY name, so the
    // latest effective rate is whichever happened to fall on a Wednesday.
    const byDate = String(dayOf(b.effective_from) || '').localeCompare(String(dayOf(a.effective_from) || ''));
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

// ── Approval rules, asked by the route AND by the button ──────────────────
// The list screen has to decide whether to OFFER Approve before it calls
// anything. If it guesses and the route disagrees, the click is a refusal the
// user never asked for — the dead-button trap this module has already shipped
// twice. So the rule lives here once and both sides ask it.

// Only plates still to be BOUGHT. A component matched to a plate already on the
// rack is headed for verification, not purchase; approving it would put a plate
// the plant already owns onto a purchase order.
export const APPROVABLE_COMPONENT_STATUSES = ['pr_required', 'replacement_required', 'not_found'];

export function approvablePlateComponents(components = []) {
  return (Array.isArray(components) ? components : [])
    .filter(row => APPROVABLE_COMPONENT_STATUSES.includes(row?.status));
}

// What a plate on the rack may be claimed FOR. The three approvable statuses —
// a line with no plate behind it — plus 'verification_required', which is the
// backlog this exists to clear: a plate the rack offered when the PR was raised
// that nobody ever walked over and confirmed. Everything else either already HAS
// its plate (verified_existing, issued) or is on its way to a vendor (approved,
// po_created); offering the rack to those would hand out the same plate twice.
export const RACK_CLAIMABLE_COMPONENT_STATUSES = [...APPROVABLE_COMPONENT_STATUSES, 'verification_required'];

// "How many of this Plate PR's plates are already on the rack?" — the live answer,
// recomputed on every read of the Requirement page.
//
// The link between a requirement and the warehouse used to be made ONCE, when the
// components were created: whatever the rack held at that instant was proposed and
// nothing ever looked again. A plate returned from the press an hour later stayed
// invisible, so the plant bought plates it already owned.
//
// The one law here is PARITY: `total` is what the Use-from-Rack button will
// actually take, not what the rack happens to hold. Five Cyan plates against one
// Cyan line is an offer of ONE. A figure that promises four and delivers two is
// worse than no figure at all, so the headline is built by summing the same
// per-colour lines the form prints — the two can never disagree.
export function rackReusePlan({ components = [], available = [] } = {}) {
  const free = new Map();
  for (const row of Array.isArray(available) ? available : []) {
    const key = plateComponentKey(row);
    free.set(key, (free.get(key) || 0) + Math.max(0, Number(row.available) || 0));
  }
  const lines = new Map();
  for (const component of Array.isArray(components) ? components : []) {
    if (!RACK_CLAIMABLE_COMPONENT_STATUSES.includes(component?.status)) continue;
    const key = plateComponentKey(component);
    const line = lines.get(key) || {
      key,
      component_type: component.component_type,
      component_label: component.component_label,
      pantone_code: component.pantone_code || null,
      needed: 0,
      // The rack figure is reported as it stands, so the form can say "1 of 5 on
      // rack" rather than silently hiding the four this PR has no use for.
      available: free.get(key) || 0,
      usable: 0,
      component_ids: [],
    };
    line.needed += 1;
    line.component_ids.push(component.id);
    lines.set(key, line);
  }
  const rows = [...lines.values()].map(line => ({ ...line, usable: Math.min(line.needed, line.available) }));
  return {
    needed: rows.reduce((sum, line) => sum + line.needed, 0),
    total: rows.reduce((sum, line) => sum + line.usable, 0),
    lines: rows,
  };
}

// 'draft' is here although the route insists on 'saved': the caller saves first
// (a draft has no size stamped on it yet), and the button must offer the action
// the WHOLE gesture can complete, not the one its second step starts from.
const APPROVABLE_REQUEST_STATUSES = ['draft', 'saved', 'pending'];

export function canApprovePlateRequest(request = {}) {
  return APPROVABLE_REQUEST_STATUSES.includes(request.approval_status)
    && approvablePlateComponents(request.components).length > 0;
}

// Undo stays available right up until a PO exists. After that the PO owns the
// decision and has its own reversal — which is what the route refuses with.
export function canUnapprovePlateRequest(request = {}) {
  if (request.approval_status !== 'approved') return false;
  if (request.po_number) return false;
  return !(request.components || []).some(row => row.po_line_id || row.grn_id
    || ['po_created', 'ordered', 'grn_received'].includes(row.status));
}

// The component states that mean a physical plate is in THIS line's hands. Two
// questions share the list: "is this line ready?" (below) and "is that rack plate
// already spoken for?" (plate-lifecycle.js builds its SQL from this array). One
// spelling, because a plate counted as free while another requirement holds it is
// a plate handed out twice.
export const PLATE_HELD_COMPONENT_STATUSES = ['verified_existing', 'available', 'reserved', 'issued'];

export function plateComponentStatus(status) {
  if (PLATE_HELD_COMPONENT_STATUSES.includes(status)) return 'ready';
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
