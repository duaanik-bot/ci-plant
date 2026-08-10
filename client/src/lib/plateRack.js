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
