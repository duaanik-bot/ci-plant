// The Sort & Paste closing arithmetic — one place, unit-tested.
//
// This module exists because the same sum has been got wrong four times in two
// days, each time by being re-derived at whichever call site needed it. The
// plant rule, in Anik's words:
//
//   "qty received 5200, complete qty 5000 — auto calculate sorting waste 200;
//    once i fill pasting waste 100 u balance."
//   "qty received 5200, complete qty 5300 (allowed) — total output remains 5300,
//    record over yield percentage."
//
// So there are two régimes, and which one applies is decided by a single sign:
//
//   produced <= received   the gap IS the waste. It is split between sorting and
//                          pasting, and typing either one rebalances the other so
//                          the pair always accounts for exactly the gap. Nothing
//                          the operator does can make the two stop adding up.
//
//   produced >  received   more came out than went in, which is a counting fact,
//                          not an error. Output STANDS at what was produced,
//                          neither waste is derived, and the excess is recorded
//                          as an over-yield percentage.
//
// `produced` is the STAGE total — earlier day counts plus the closing entry — so
// a four-day job measures its gap once, at the end, against everything it made.
const n = v => {
  const x = Math.round(+v || 0);
  return x > 0 ? x : 0;
};
const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);

export function balanceWaste({ received, produced, sortWaste, pasteWaste, edited } = {}) {
  const rec = n(received);
  const out = n(produced);
  const gap = rec - out;

  let sort, paste;
  if (gap > 0) {
    // UNDER. The two wastes share the gap between them; whichever the operator
    // just touched is honoured (clamped to the gap) and the other takes the rest.
    if (edited === 'paste') {
      paste = Math.min(n(pasteWaste), gap);
      sort = gap - paste;
    } else if (edited === 'sort') {
      sort = Math.min(n(sortWaste), gap);
      paste = gap - sort;
    } else {
      // Untouched: the whole gap is sorting's until someone says otherwise.
      // Sorting comes first on the floor, so it is the honest default.
      paste = Math.min(n(pasteWaste), gap);
      sort = gap - paste;
    }
  } else {
    // OVER or exact. Nothing to apportion — both figures are the operator's own
    // count, and inventing waste here would contradict "output remains 5,300".
    sort = n(sortWaste);
    paste = n(pasteWaste);
  }

  const totalWaste = sort + paste;
  const over = Math.max(0, out - rec);
  // Everything the station handled, so yield% + sorting% + pasting% total 100 and
  // a report can add them across jobs without a shared denominator.
  const handled = out + totalWaste;
  // The two waste shares are rounded, and YIELD IS THE REMAINDER. Rounding all
  // three independently gives 94.5 + 3.6 + 1.8 = 99.9, and a report that adds a
  // column of those is short a tenth on every job. Yield is the figure with the
  // most room to absorb it.
  const sortPct = pct(sort, handled);
  const pastePct = pct(paste, handled);
  const yieldPct = handled > 0 ? Math.round((100 - sortPct - pastePct) * 10) / 10 : 0;
  return {
    output: out,
    sortWaste: sort,
    pasteWaste: paste,
    totalWaste,
    gap: Math.max(0, gap),
    over,
    overPct: pct(over, rec),
    handled,
    yieldPct,
    sortPct,
    pastePct,
  };
}
