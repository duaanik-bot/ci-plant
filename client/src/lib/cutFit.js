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

// Client twin of helpers.leftoverStrips, and the same contract: the offcut of
// the layout clientFit above just won, on the parent the planner is ACTUALLY
// cutting. The Planning Engine lets that parent be trimmed off the board's
// mother sheet live in the dialog (Parent L/W), and a trim moves the strip —
// 20×24.5 out of a 20×38 board leaves a bankable 20×13.5", out of the same
// board trimmed to 20×26 it leaves 20×1.5", which is waste. Recomputing here
// off the live cut plan is what keeps the Leftover card describing the cut
// being locked rather than the one the dialog opened on; the server re-derives
// it the same way and 409s anything that does not match.
//
// Change this and helpers.leftoverStrips together — cut-sizing.test.js asserts
// the two never diverge.
export function clientStrips(parentL, parentW, childL, childW) {
  const fit = clientFit(parentL, parentW, childL, childW);
  if (!fit || fit.cpp <= 0) return [];
  // Only a plain grid leaves the two clean rectangles this banks; mixed and
  // area won their extra cut out of exactly that remainder.
  if (fit.basis !== 'grid') return [];
  const PL = +parentL, PW = +parentW;
  // Whichever way round the winning grid ran — clientFit reports the count but
  // not the orientation, so re-derive it here on the same tie rule childFit
  // uses (normal wins a tie, rotated only when STRICTLY bigger).
  const rotated = fitDown(PL, +childW) * fitDown(PW, +childL)
                > fitDown(PL, +childL) * fitDown(PW, +childW);
  const cl = rotated ? +childW : +childL;
  const cw = rotated ? +childL : +childW;
  const nL = fitDown(PL, cl), nW = fitDown(PW, cw);
  const raw = [
    { l: +(PL - nL * cl).toFixed(2), w: PW },                    // strip along the length
    { l: +(nL * cl).toFixed(2), w: +(PW - nW * cw).toFixed(2) }, // strip under the grid
  ];
  return raw
    .map(s => ({ l: Math.max(s.l, s.w), w: Math.min(s.l, s.w) }))
    .filter(s => s.w > 0.05)
    .map(s => ({ ...s, usable: s.w >= 3, strips_per_parent: 1 }));
}
