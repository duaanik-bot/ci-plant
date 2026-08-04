// Client twin of helpers.childFit — the Planning Engine recomputes the cut
// locally for live previews (the Warehouse Picker's fit column, Planning's
// calc.parent and gangCalc), so this must agree with the server cut for cut or
// a Board Mix reads green here against a requirement the server computes
// higher, and 409s on save.
//
// Three layouts, best count wins, `basis` names which one produced it:
// grid → mixed (one guillotine cut, each block its own way) → the
// quarter-sheet area reach. helpers.childFit carries the full reasoning and
// the three guards on that last rule — read it there, and change both twins
// together. cut-sizing.test.js asserts they never diverge.
//
// EPS guards the division the same way childFit does: a parent/child ratio
// that is a whole number mathematically can still land a hair under it in
// floating point (5.999999999998 instead of 6), which would floor to one
// fewer cut than the real one and understate cpp here while childFit gets it
// right server-side.
const EPS = 1e-6;
const fitDown = (span, edge) => Math.floor(span / edge + EPS);

// Best single-orientation grid inside one rectangle, either way round.
function gridFit(RL, RW, cl, cw) {
  if (!(RL > EPS) || !(RW > EPS)) return 0;
  return Math.max(fitDown(RL, cl) * fitDown(RW, cw), fitDown(RL, cw) * fitDown(RW, cl));
}

// One straight guillotine cut, each block gridded in its own orientation.
function mixedFit(PL, PW, cl, cw) {
  let best = 0;
  const offsets = span => {
    const out = [];
    for (const edge of [cl, cw])
      for (let k = 1; k * edge < span - EPS; k++) out.push(k * edge);
    return out;
  };
  for (const x of offsets(PL))
    best = Math.max(best, gridFit(x, PW, cl, cw) + gridFit(PL - x, PW, cl, cw));
  for (const y of offsets(PW))
    best = Math.max(best, gridFit(PL, y, cl, cw) + gridFit(PL, PW - y, cl, cw));
  return best;
}

// Does the child fit inside a quarter of the parent, either way round?
function fitsQuarter(PL, PW, cl, cw) {
  const qShort = Math.min(PL, PW) / 2, qLong = Math.max(PL, PW) / 2;
  return Math.min(cl, cw) <= qShort + EPS && Math.max(cl, cw) <= qLong + EPS;
}

export function clientFit(parentL, parentW, childL, childW) {
  const PL = +parentL, PW = +parentW, cl = +childL, cw = +childW;
  if (!(PL > 0 && PW > 0 && cl > 0 && cw > 0)) return null;
  const grid = Math.max(fitDown(PL, cl) * fitDown(PW, cw), fitDown(PL, cw) * fitDown(PW, cl));
  if (grid <= 0) return { cpp: 0, waste: 100, util: 0, basis: 'grid' };

  let cpp = grid, basis = 'grid';
  const mixed = mixedFit(PL, PW, cl, cw);
  if (mixed > cpp) { cpp = mixed; basis = 'mixed'; }
  if (cpp === 4
    && Math.floor((PL * PW) / (cl * cw) + EPS) === 5
    && fitsQuarter(PL, PW, cl, cw)) { cpp = 5; basis = 'area'; }

  const util = Math.min(100, (cpp * cl * cw) / (PL * PW) * 100);
  return { cpp, util: +util.toFixed(1), waste: +Math.max(0, 100 - util).toFixed(1), basis };
}
