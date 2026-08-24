// Dispatch tolerance — ONE spelling of "how far past the ordered quantity may
// this line ship, and does anything stop it".
//
// A customer's tolerance is a percentage. **-1 is the plant's spelling of NO
// LIMIT**: Galpha, Fluence and Pureflix accept whatever comes, over or short,
// so there is no ceiling to compute and no 409 to raise against them.
//
// Why a sentinel inside the SAME column rather than a second boolean: every
// query in the app already resolves the effective value with
// `COALESCE(ol.tolerance_pct, c.tolerance_pct, 0)` — line snapshot first, then
// the customer master. A parallel `tolerance_unlimited` flag would have to be
// threaded through a dozen SQL sites and both fallback rungs, and the one site
// that got missed would be a gate that silently still blocks. -1 rides the
// existing COALESCE untouched, so the only code that must change is the code
// that turns a percentage into a ceiling — which is now exactly this file.
//
// 100 was the old workaround (Fluence and Pureflix were both sitting at 100%).
// It is NOT the same thing: it caps at twice the order, and the plant hit that
// cap. Anything already at 100 stays a real 100% limit unless it is set to
// No limit explicitly.
//
// Twin: client/src/lib/tolerance.js — kept honest by tolerance-no-limit.test.js,
// which imports both and asserts they agree case for case.

export const NO_LIMIT = -1;

// Any negative value reads as no-limit. A hand-typed -5 must never quietly
// become a ceiling BELOW the ordered quantity — that would refuse dispatches
// the order plainly allows. The DB CHECK pins the column to -1 or >= 0; this is
// the belt to that braces.
export function isNoLimit(pct) {
  const n = Number(pct);
  return Number.isFinite(n) && n < 0;
}

// The most that may ever stand dispatched against this line.
//
// Returns Infinity under no-limit — which is correct arithmetic and a trap on
// the wire, because JSON.stringify(Infinity) is `null`. Never put this value
// straight into a response body; use `ceilingForWire()`.
export function toleranceCeiling(ordered, pct) {
  const o = Math.max(0, +ordered || 0);
  if (isNoLimit(pct)) return Number.POSITIVE_INFINITY;
  return Math.floor(o * (1 + Math.max(0, +pct || 0) / 100));
}

// The ceiling as a response field: a number, or null meaning "no ceiling".
export function ceilingForWire(ordered, pct) {
  return isNoLimit(pct) ? null : toleranceCeiling(ordered, pct);
}

// How much MORE may go out on this line. Infinity under no-limit.
export function toleranceRoom(ordered, dispatched, pct) {
  return Math.max(0, toleranceCeiling(ordered, pct) - Math.max(0, +dispatched || 0));
}

// Does a proposed running total breach the ceiling? Always false under
// no-limit — which is the whole point: no 409, no trim dialog, no override.
export function exceedsTolerance(total, ordered, pct) {
  return Math.max(0, +total || 0) > toleranceCeiling(ordered, pct);
}

// What the plant reads on a screen. '±-1%' is not a thing.
export function toleranceLabel(pct) {
  if (isNoLimit(pct)) return 'No limit';
  return `±${Math.max(0, +pct || 0)}%`;
}

// True when the tolerance is worth showing at all: 0 means "exactly what was
// ordered", which is the default and needs no chip.
export function hasTolerance(pct) {
  return isNoLimit(pct) || Math.max(0, +pct || 0) > 0;
}
