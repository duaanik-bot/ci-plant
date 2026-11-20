// Retired plate sets — shipped only when the Set aside view asks for them.
//
// Scrapped, lost and damaged sets were 271 of 689 warehouse sets and 39% of
// /plates/warehouse (20 Nov 2026), yet the screen shows them only under
// "Set aside". Opt-in, like ?settled=hide on Plate PRs: no parameter is the
// legacy array, so an older bundle on a plant tablet keeps working.
//
// Split AFTER grouping, not in SQL: a set's grouping key includes its status,
// so a set is wholly retired or not at all, and the hidden count is then exactly
// the number of sets ?retired=only returns — no second query to drift from it.
export const RETIRED_PLATE_STATUSES = ['scrapped', 'lost', 'damaged'];

const isRetired = set => RETIRED_PLATE_STATUSES.includes(set.status);

// ?retired= → 'hide' | 'only' | 'all'. Anything else is the legacy answer.
export function retiredMode(value) {
  return value === 'hide' || value === 'only' ? value : 'all';
}

// 'all' → the sets as given; 'hide' → { rows, retired_count }; 'only' → retired sets.
export function splitRetiredSets(sets, mode) {
  if (mode === 'only') return sets.filter(isRetired);
  if (mode === 'hide') {
    const rows = sets.filter(set => !isRetired(set));
    return { rows, retired_count: sets.length - rows.length };
  }
  return sets;
}
