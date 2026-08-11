// Client twin of the server's co-printed run arithmetic — shared-layout.js's
// sharedLayoutRun plus the plan lock's parent conversion. PURE: plain rows in,
// numbers out. Change this and the server pair together —
// shared-layout.test.js pins the two to the same figures.
//
// A SHARED layout nests every member on ONE child sheet, so one pass of the
// press advances every member at once and the run is the MAX any member
// needs — never the SUM the members' own reference figures add up to:
//
//     runChild  = max_i( ceil(net_i / ups_i) ) + wastage (single allowance)
//     runParent = ceil(runChild / cpp)
//
// The per-member naturals (each job's own child→parent count) stay what the
// Gang Engine DISPLAYS as reference; this module owns only the run-level
// figures the plant actually buys and issues board against.
//
// Where the server twin THROWS (a member without ups has no place on a
// layout), this returns null — the engine is live-editing and degrades to the
// classic sum plus the existing "enter ups" banner instead of blanking.

export function sharedRunFigures(members = [], { wastage = 0, cpp = null } = {}) {
  if (!members.length) return null;
  const rows = members.map(m => ({ id: m.id, net: Math.max(0, +m.net || 0), ups: +m.ups }));
  if (rows.some(m => !(m.ups > 0))) return null;

  const w = Math.max(0, Math.round(+wastage || 0));
  // No settled geometry yet → 1 child : 1 parent, the same fallback
  // memberParentSheets uses server-side.
  const perParent = +cpp > 0 ? +cpp : 1;

  const needs = rows.map(m => Math.ceil(m.net / m.ups));
  const needChild = Math.max(...needs, 0);
  const runChild = needChild + w;
  const needParent = Math.ceil(needChild / perParent);
  const runParent = Math.ceil(runChild / perParent);

  return {
    needChild,                        // sheets the orders actually need
    runChild,                         // sheets the press runs (incl. wastage)
    needParent,
    runParent,                        // parent sheets the plant buys/issues
    childWastage: w,
    parentWastage: runParent - needParent,
    totalUps: rows.reduce((s, m) => s + m.ups, 0),
    per: rows.map((m, i) => ({
      id: m.id,
      ups: m.ups,
      needChild: needs[i],
      // What the run yields this member if every sheet prints — the run's
      // wastage sheets are an allowance, so this is the ceiling, not a promise.
      yieldPieces: runChild * m.ups,
    })),
  };
}
