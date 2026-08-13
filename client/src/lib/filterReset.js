// "Show me everything again" — the one control every filtered page owes the
// user, and the logic behind it.
//
// These pages stack filters: a tab, a set-type zone, board-status cards, a KPI
// card, colour chips, a customer chip, a search box. Each one is easy to leave
// on, and once two or three are lit a page showing four rows out of two hundred
// looks exactly like a page that has lost its data. The way out has to be ONE
// obvious control, not a hunt for whichever chip is still dark.
//
// WHAT RESETS: narrowing only — filters, chips, searches, KPI cards, and the
// row selection that goes with them (a selection surviving a filter change is
// how a bulk action ends up carrying rows the user can no longer see; every
// page here already clears it on each individual filter change, so the reset
// must too).
//
// WHAT DOES NOT: the tab or view you are on. Moving someone from "To Plan" to
// "All" is navigation, not a reset, and it would lose their place. A zone chip
// that defaults to 'all' IS narrowing and does reset — the test is whether the
// control has a default that means "everything", not whether it looks like a tab.

// Is this axis still at its default? Arrays are compared as SETS: a filter list
// holds which chips are lit, and lighting A then B is the same view as lighting
// B then A — order is not part of the meaning, so it must not make a page look
// dirty. Sets and Maps are compared by size and membership for the same reason.
export function sameFilterValue(a, b) {
  if (a === b) return true;
  // null and undefined and '' all mean "nothing chosen" for a filter axis, and
  // pages spell that differently. Treating them as equal keeps a page from
  // reading dirty because a Select handed back null where '' was the default.
  const empty = v => v == null || v === '';
  if (empty(a) && empty(b)) return true;
  if (a instanceof Set || b instanceof Set) {
    if (!(a instanceof Set) || !(b instanceof Set)) return false;
    if (a.size !== b.size) return false;
    for (const v of a) if (!b.has(v)) return false;
    return true;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    const rest = [...b];
    for (const v of a) {
      const i = rest.findIndex(x => x === v);
      if (i === -1) return false;
      rest.splice(i, 1);
    }
    return true;
  }
  // A map of sub-searches — Print Planning keeps every lane's own box in one
  // object keyed by lane. Keys whose value is empty do not count: typing into a
  // lane and deleting it again leaves {triage: ''} behind, and that still means
  // nobody is searching. Only compared one level deep, which is all this shape
  // ever is.
  if (isPlainObject(a) || isPlainObject(b)) {
    if (!isPlainObject(a) || !isPlainObject(b)) return false;
    const live = o => Object.entries(o).filter(([, v]) => !empty(v));
    const [ea, eb] = [live(a), live(b)];
    if (ea.length !== eb.length) return false;
    return ea.every(([k, v]) => Object.prototype.hasOwnProperty.call(b, k) && b[k] === v);
  }
  return false;
}

// Plain `{}` only — a Date, a Set or a class instance is not a filter map, and
// treating one as a bag of keys would silently call two different values equal.
function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

// Does this page currently narrow anything? Drives whether the button is worth
// showing at all: a reset offered on an unfiltered page is a control that does
// nothing, and one more thing to read on a rail that is already busy.
//
// `entries` are [value, setter, default] triples — the axis as it stands, how to
// put it back, and what "back" means. Malformed entries are ignored rather than
// thrown on: this runs during render on every filtered page in the ERP, and a
// typo in one page's list must not blank the screen.
export function filtersDirty(entries) {
  if (!Array.isArray(entries)) return false;
  return entries.some(e => Array.isArray(e) && e.length >= 3 && !sameFilterValue(e[0], e[2]));
}

// The axes that are actually narrowing, by the label each was given — the
// sentence the page says back so a reset is never a mystery ("Cleared: search,
// board, customer"). Entries may carry a 4th slot with that label.
export function dirtyFilterLabels(entries) {
  if (!Array.isArray(entries)) return [];
  return entries
    .filter(e => Array.isArray(e) && e.length >= 3 && !sameFilterValue(e[0], e[2]))
    .map(e => e[3])
    .filter(Boolean);
}

// Put every axis back to its default. Setters are called with the default
// value, which is also why a hook like useKpiFilter's `clear` (it ignores its
// argument) can be handed straight in as the setter.
export function applyFilterReset(entries) {
  if (!Array.isArray(entries)) return;
  for (const e of entries) {
    if (!Array.isArray(e) || e.length < 3) continue;
    const [, set, dflt] = e;
    if (typeof set !== 'function') continue;
    // A fresh copy per reset: handing the same array identity back to every
    // page would let one page's later mutation land in another's default.
    set(Array.isArray(dflt) ? [...dflt]
      : dflt instanceof Set ? new Set(dflt)
      : isPlainObject(dflt) ? { ...dflt }
      : dflt);
  }
}
