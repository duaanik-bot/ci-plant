// The plant's search normalizer: what an operator types on the floor should find
// the row, without them having to reproduce the punctuation stored in it.
//
// A board is spoken and written as "2038"; the master stores
// 'Duplex GB · 296 GSM · 20 x 38'. squash() reduces both to the same key.
//
// Server twin of client/src/lib/searchKey.js — the client filters rows in the
// browser (rowMatches, Combobox) and the server filters the same data in SQL
// (warehouse picker, sales orders, timeline), so the two MUST agree or the same
// query returns different rows depending on which side ran it.
// search-key.test.js asserts the two twins export the same surface and produce
// identical output — keep them byte-identical below this header.

// Collapses the dimension separator FIRST, then strips punctuation. Order
// matters and is the whole point: stripping punctuation alone leaves '20x38',
// and nobody types the x. Both steps are needed for '2038' to hit.
//
// Accepts 'x', '×' and '*' as separators, with or without surrounding spaces.
export function squash(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/(\d)\s*[x×*]\s*(\d)/g, '$1$2')
    .replace(/[^a-z0-9]+/g, '');
}

// A term hits if the RAW haystack contains it, OR the squashed haystack contains
// the squashed term. The OR is a safety property, not a convenience: squashing
// destroys punctuation, so a term that depends on it ('31.5', 'CI-BOX') would
// stop matching if the squashed comparison replaced the raw one instead of
// adding to it. This way normalization only ever widens the result set.
export function matchesTerm(raw, squashed, term) {
  if (String(raw ?? '').includes(term)) return true;
  const s = squash(term);
  return !!s && String(squashed ?? '').includes(s);
}

// The Postgres twin of squash(), for use inside a WHERE clause. Same two steps
// in the same order. `col` is interpolated as SQL, so it must be a column
// reference the caller controls — never user input.
//
// The separator is an ALTERNATION, not a bracket expression, and that is load
// bearing. '×' (U+00D7) is two bytes in UTF-8, and the local database is
// SQL_ASCII while Supabase is UTF8 — under SQL_ASCII a bracket expression is a
// set of single BYTES, so '[x×*]' matches only half of '×' and the surrounding
// pattern never completes. An alternation branch matches the whole byte sequence
// literally, so it behaves identically under both encodings. See PG_SEPARATOR.
export const PG_SEPARATOR = String.raw`(?:x|X|×|\*)`;

export function squashSql(col) {
  return `regexp_replace(regexp_replace(lower(${col}), '([0-9])[[:space:]]*${PG_SEPARATOR}[[:space:]]*([0-9])', '\\1\\2', 'g'), '[^a-z0-9]+', '', 'g')`;
}
