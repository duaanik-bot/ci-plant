// Rack figures for the Plates Warehouse KPI strip.
//
// Mirrors plateRackSummary() in server/src/plates.js, which is the tested definition
// — the fresh/used split is a client-side filter, so the count has to be taken after
// that filter rather than shipped down with the rows. Keep the two in step; the
// server copy carries the unit tests.

// The plant's controlled sizes, in reading order. 600 x 730 leads because it is the
// main offset size; 560 x 670 is the metallic one and always the second question.
export const PLATE_SIZES_IN_ORDER = ['600 x 730', '560 x 670'];

// Why a rack plate is being retired. Offered as one-tap choices because the reason
// is optional — the point is to make recording it easier than skipping it, not to
// gate the decision behind a text box. 'Other' opens free text.
export const PLATE_RETIRE_REASONS = [
  'Damaged',
  'Worn out — dot loss',
  'Artwork changed',
  'Scratched in store',
  'Wrong size / obsolete',
  'Other',
];

// Why a plate is coming OFF the rack today — a different question from
// PLATE_RETIRE_REASONS above, which asks why a plate is dead. Sharing that list
// would offer "Artwork changed" as a temporary state and "Can't find it" as a
// reason to scrap.
//
// This is the only copy. server/src/plates.js imports it from here, the same
// direction server/src/helpers.js already imports productCode.js — one home
// beats a twin that has to be kept in step.
//
// No entry carries a condition: setting a plate aside records WHERE it stands,
// never re-grades it. Grading is what inspection does.
export const PLATE_SET_ASIDE_REASONS = [
  { key: 'damaged', label: 'Damaged',        status: 'damaged',               action: 'damaged' },
  { key: 'missing', label: "Can't find it",  status: 'lost',                  action: 'not_found' },
  { key: 'check',   label: 'Needs checking', status: 'awaiting_verification', action: 'verification_requested' },
  { key: 'other',   label: 'Other',          status: 'awaiting_verification', action: 'verification_requested' },
];

// ── Sync Master? ──────────────────────────────────────────────────────────
// The output number is NOT a hard gate on the Add Plates form. A plate can be
// entered by product when nobody remembers the number, and the number can be
// typed for a carton whose master has never carried one — which is the ordinary
// state of a master that has not caught up with the plant.
//
// So the plant's existing fork applies here too: "Sync Master? / This Job Only",
// the same one the Artwork form uses for output_number (see db.js and
// PUT /orders/:id). output_number is OURS to write — unlike party_item_code and
// party_artwork_code, which belong to the customer and are never rewritten.
//
// FILLING A BLANK AND OVERWRITING A NUMBER ARE DIFFERENT ACTS:
//   • missing  — the master is incomplete and the plant is telling it the
//     answer. Offered ticked.
//   • conflict — the master already names a different number. That is a
//     disagreement about which is right and nothing here knows, so it is
//     offered UNTICKED and prints both. Auto-syncing this case is how a typo in
//     a warehouse form silently renames the number every future job for that
//     carton prints under.
//
// This is the only copy. server/src/plates.js imports it from here, the same
// direction PLATE_SET_ASIDE_REASONS already travels — the route recomputes the
// state rather than trusting the form's flag, so a stale screen cannot overwrite
// a master that moved under it. A twin would let the button offer one thing and
// the route do another.
export function masterOutputSync({ typed, master } = {}) {
  const wanted = String(typed ?? '').trim();
  const held = String(master ?? '').trim();
  if (!wanted || wanted === held) return { state: 'in_sync', offer: false, suggested: false };
  if (!held) return { state: 'missing', offer: true, suggested: true, from: '', to: wanted };
  return { state: 'conflict', offer: true, suggested: false, from: held, to: wanted };
}

const DAY = 24 * 60 * 60 * 1000;

// Counted in PHYSICAL PLATES, not sets — a warehouse row is a set of four, and "4"
// on a KPI card has to mean four plates. Undated plates are counted in the total but
// cannot be averaged, so they neither inflate nor deflate the age.
export function plateRackSummary(sets = [], today = new Date()) {
  const rows = Array.isArray(sets) ? sets : [];
  const bySize = new Map(PLATE_SIZES_IN_ORDER.map(size => [size, 0]));
  let total = 0;
  const ages = [];
  // Wear and shelf age answer different questions and can disagree completely: two
  // plates cut on the same day, one with eleven runs and one with none, are the same
  // AGE and nothing like the same plate. The rack reports both.
  const runs = [];
  for (const set of rows) {
    const size = set.plate_size || 'Other';
    const plates = set.components?.length ? set.components : [set];
    bySize.set(size, (bySize.get(size) || 0) + plates.length);
    total += plates.length;
    for (const plate of plates) {
      // use_count is NOT NULL DEFAULT 0, so a missing value means never run — it
      // belongs in the average as a zero, not skipped like an unknown date.
      runs.push(Math.max(0, Number(plate.use_count) || 0));
      const created = plate.plate_created_on || set.plate_created_on;
      if (!created) continue;
      const days = Math.round((today - new Date(created)) / DAY);
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

// What the picker opens with: the plate the line already holds if it holds one,
// otherwise the best candidate — which is the plate the one-click button would
// have taken. Opening on anything else would make Confirm mean something
// different from the button it replaced.
export function defaultPickSelection(lines = []) {
  const out = {};
  for (const line of Array.isArray(lines) ? lines : []) {
    const candidates = line.candidates || [];
    out[line.component_id] = candidates.find(row => row.current)?.id ?? candidates[0]?.id ?? null;
  }
  return out;
}

// Two lines of the same colour list the same plates, so picking one plate twice
// is an easy slip. The server refuses it either way; catching it here means the
// planner is told before a round trip that half-succeeds.
export function duplicatePickAssets(selection = {}) {
  const seen = new Set();
  const duplicates = new Set();
  for (const assetId of Object.values(selection || {})) {
    if (!assetId) continue;
    if (seen.has(assetId)) duplicates.add(assetId);
    else seen.add(assetId);
  }
  return [...duplicates];
}

// An unticked line is a colour the planner has chosen to buy rather than reuse.
// It is left out of the payload, not sent as a null the server has to interpret.
export function pickPayload(selection = {}) {
  return Object.entries(selection || {})
    .filter(([, assetId]) => Boolean(assetId))
    .map(([componentId, assetId]) => ({ component_id: Number(componentId), asset_id: Number(assetId) }));
}
