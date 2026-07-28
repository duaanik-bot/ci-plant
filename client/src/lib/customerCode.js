// Customer initials — the short form a plant list shows where the full
// registered name would eat the column.
//
// "Swiss Garnier Life Sciences" reads as SGLS on the floor, and that is already
// how the plant codes its companies (the shade-card codes run SGB, SGLS…). The
// legal tail is dropped because it never distinguishes anyone: every second
// customer is a "Private Limited", so keeping it would turn SGB into SGBPL and
// make the initials longer AND less telling at the same time.
//
// A name that survives as a single word keeps four letters rather than one —
// "Herboveda" as "H" identifies nothing.
//
// This is a DISPLAY form only. Nothing is stored or matched against it on the
// server; wherever a cell shows initials, the row's full customer name must stay
// in the search haystack (DataTable's `searchValue`) so typing "swiss" still
// finds a row that reads "SGLS".

// Words carrying no identity — legal form, conjunctions, articles. Matched after
// punctuation is stripped, so "Pvt." and "Pvt" are the same word.
const NOISE_WORD = new Set([
  'pvt', 'private', 'ltd', 'limited', 'llp', 'plc', 'inc', 'incorporated',
  'co', 'corp', 'corporation', 'company', 'gmbh', 'sa', 'srl', 'bv', 'nv',
  'and', 'the', 'of',
]);

const MAX_INITIALS = 5;
const SINGLE_WORD_LETTERS = 4;

// Returns '' for an empty/absent name so callers can fall back to a dash rather
// than render an empty chip.
export function customerInitials(name) {
  const words = String(name ?? '')
    .split(/\s+/)
    .map(w => w.replace(/[^A-Za-z0-9]/g, ''))
    .filter(Boolean);
  if (!words.length) return '';
  const significant = words.filter(w => !NOISE_WORD.has(w.toLowerCase()));
  // A name made only of noise ("The Company") still has to render as something,
  // so fall back to the words as written rather than to nothing.
  const use = significant.length ? significant : words;
  if (use.length === 1) return use[0].slice(0, SINGLE_WORD_LETTERS).toUpperCase();
  return use.slice(0, MAX_INITIALS).map(w => w[0]).join('').toUpperCase();
}

// Everything a search box must match for a cell that DISPLAYS initials: the
// initials themselves, plus the full name they were shortened from. Handed to
// DataTable as part of a column's `searchValue`.
export function customerSearchText(name) {
  const abbr = customerInitials(name);
  const full = String(name ?? '').trim();
  return abbr && abbr !== full ? `${abbr} ${full}` : full;
}
