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

// Client twin of helpers.chosenCutsValid / helpers.chosenStrips, flat-arg
// convention matching clientFit/clientStrips above. Same "take k of max,
// bank the rest" contract: k at the fit's own max defers to clientStrips
// (identical to a grid fit; empty on a mixed/area fit). A sub-max k's grid
// orientation is recomputed independently rather than trusted off
// clientFit's `basis` — see the server twin's own comment on why
// 'mixed'/'area' can't say which of normal/rotated was the bigger grid.
// Change this and the server pair together; chosen-strips.test.js asserts
// they never diverge.
function bestGridOrientation(PL, PW, cl0, cw0) {
  const normal = fitDown(PL, cl0) * fitDown(PW, cw0);
  const rotated = fitDown(PL, cw0) * fitDown(PW, cl0);
  return rotated > normal ? [cw0, cl0] : [cl0, cw0];
}

export function chosenCutsValid(parentL, parentW, childL, childW, k) {
  const fit = clientFit(parentL, parentW, childL, childW);
  if (!fit || fit.cpp <= 0) return { ok: false, max: 0, why: 'This board and child size cut nothing' };
  const kk = Math.round(+k || 0);
  if (kk === fit.cpp) return { ok: true, max: fit.cpp, grid: true };
  const PL = +parentL, PW = +parentW;
  const [cl, cw] = bestGridOrientation(PL, PW, +childL, +childW);
  const nL = fitDown(PL, cl), nW = fitDown(PW, cw);
  const gridMax = nL * nW;
  if (kk < 1 || kk > fit.cpp)
    return { ok: false, max: fit.cpp, why: `Cuts must be between 1 and ${fit.cpp}` };
  if (kk > gridMax)
    return {
      ok: false, max: fit.cpp,
      why: `Cuts above ${gridMax} leave no clean strip unless you take all ${fit.cpp} — `
        + `choose ${gridMax} or fewer, or all ${fit.cpp}`,
    };
  if (kk % nW !== 0)
    return { ok: false, max: fit.cpp, why: `On this board cuts step by ${nW} — a ragged take leaves no clean strip` };
  return { ok: true, max: fit.cpp, grid: true };
}

export function chosenStrips(parentL, parentW, childL, childW, k) {
  const v = chosenCutsValid(parentL, parentW, childL, childW, k);
  if (!v.ok) return [];
  const fit = clientFit(parentL, parentW, childL, childW);
  if (Math.round(+k) === fit.cpp) return clientStrips(parentL, parentW, childL, childW);
  const PL = +parentL, PW = +parentW;
  const [cl, cw] = bestGridOrientation(PL, PW, +childL, +childW);
  const nW = fitDown(PW, cw);
  const c = Math.round(+k) / nW;
  const raw = [
    { l: +(PL - c * cl).toFixed(2), w: PW },
    { l: +(c * cl).toFixed(2), w: +(PW - nW * cw).toFixed(2) },
  ];
  return raw
    .map(s => ({ l: Math.max(s.l, s.w), w: Math.min(s.l, s.w) }))
    .filter(s => s.w > 0.05)
    .map(s => ({ ...s, usable: s.w >= 3, strips_per_parent: 1 }));
}

// ── The parent a cut is measured on ─────────────────────────────────────────
// Client twins of helpers.parentFitsBoard / cuttingParent / parentLosesCuts,
// so the planning screens count cuts on the SAME parent the lock does. On
// 19 Sep 2026 CI-MRG-0028 read "Covered" (3,550 sheets, counted on the 23×38
// board) and its lock wrote 10,650 (counted on SW-544's 22×28 parent on file,
// a size left over from its old board). parent-loses-cuts.test.js pins these
// twins against their server originals — change both together.
//
// ONE deliberate difference from the server: a BLANK form field ('') means
// "no parent — the board's full sheet" here. The server only ever sees numbers
// or NULL from the database, and would read '' as an unsized 0×0 sheet.
// Every twin also accepts null arguments: a throw while rendering would take
// the whole Planning page down.

// Same sheet, either way round (23×38 is 38×23). Unsized is never "same".
export function sameSheet(a, b) {
  const al = +a?.l, aw = +a?.w, bl = +b?.l, bw = +b?.w;
  if (!(al > 0 && aw > 0 && bl > 0 && bw > 0)) return false;
  return Math.abs(Math.max(al, aw) - Math.max(bl, bw)) < EPS
      && Math.abs(Math.min(al, aw) - Math.min(bl, bw)) < EPS;
}

// Twin of helpers.parentFitsBoard: can this parent be trimmed out of the
// board? Orientation-free, equal is fine, and unsized answers true ("cannot
// judge" never refuses).
function fitsBoard(pl, pw, bl, bw) {
  if (!(pl > 0 && pw > 0 && bl > 0 && bw > 0)) return true;
  return Math.max(pl, pw) <= Math.max(bl, bw) + EPS && Math.min(pl, pw) <= Math.min(bl, bw) + EPS;
}

const blank = v => v == null || v === '';

// The parent on file does not fit inside its board — an edge too long, either
// way round — so no guillotine can cut it out, and helpers.planLockParent
// refuses the lock (the 14-Sep rule). The planning screens say so BEFORE the
// lock. Blank or unsized answers false: "cannot judge" never warns.
export function parentTooBig(args) {
  const { parentL, parentW, boardL, boardW } = args ?? {};
  if (blank(parentL) || blank(parentW)) return false;
  const pl = +parentL, pw = +parentW, bl = +boardL, bw = +boardW;
  if (!(pl > 0 && pw > 0 && bl > 0 && bw > 0)) return false;
  return !fitsBoard(pl, pw, bl, bw);
}

// Twin of helpers.cuttingParent: the parent on file when there is one and the
// board can yield it, else the board's own sheet.
export function cutParentOf(parent, board) {
  const { parent_l, parent_w } = parent ?? {};
  const bl = +board?.sheet_l, bw = +board?.sheet_w;
  if (blank(parent_l) || blank(parent_w)) return { l: bl, w: bw };
  const pl = +parent_l, pw = +parent_w;
  return fitsBoard(pl, pw, bl, bw) ? { l: pl, w: pw } : { l: bl, w: bw };
}

// One member's cut on a run — what gangCalc counts it on. The server spelling is
// memberParentSheets (helpers.js): childFit(cuttingParent(m, m's board), m),
// which parentSheetsRequired clamps to at least 1. run-member-cut.test.js holds
// the two together.
//   member        a run member as MEMBER_VIEW sends it: its parent on file
//                 (parent_l/_w), ITS OWN board's sheet (sheet_l/_w), its child
//   coPrinted     a co-printed run's lock cuts the board's own sheet and never
//                 reads a parent on file
//   childFallback { child_l, child_w } — the run's lead — for a member with no
//                 child of its own, on a CO-PRINTED run only: that run prints one
//                 shared child. Off one, a member cuts its own child, and the
//                 server counts one without a child 1:1 (childFit, unsized), so
//                 this does too (Task 10, round 2).
// Always the member's OWN board. gangCalc once fell back to the lead's board
// for an unsized member, counting a sheet that member is never cut from; the
// server issues it 1:1, and so does this (Task 10, 19 Sep 2026).
// Returns { l, w, cpp }: the sheet the cut is measured on, and its cuts.
export function runMemberCut(args) {
  const { member, coPrinted = false, childFallback } = args ?? {};
  const board = { sheet_l: member?.sheet_l, sheet_w: member?.sheet_w };
  const par = coPrinted ? { l: +board.sheet_l, w: +board.sheet_w } : cutParentOf(member, board);
  const lend = coPrinted ? childFallback : null;
  const fit = clientFit(par.l, par.w, +member?.child_l || +lend?.child_l, +member?.child_w || +lend?.child_w);
  return { l: par.l, w: par.w, cpp: fit && fit.cpp > 0 ? fit.cpp : 1 };
}

// Twin of helpers.parentLosesCuts: the parent on file can be trimmed out of
// the board, yet it yields FEWER children than the board's own sheet. A
// WARNING, never a refusal — a deliberate trim is the planner's call (Anik,
// 2026-09-19: no hard blockers in the planning engine).
export function parentLosesCuts(args) {
  const { parentL, parentW, boardL, boardW, childL, childW } = args ?? {};
  if (blank(parentL) || blank(parentW)) return null;
  const pl = +parentL, pw = +parentW, bl = +boardL, bw = +boardW;
  if (!(pl > 0 && pw > 0 && bl > 0 && bw > 0)) return null;
  if (!fitsBoard(pl, pw, bl, bw)) return null;   // does not fit the board: parentTooBig's case
  const onParent = clientFit(pl, pw, childL, childW);
  const onBoard = clientFit(bl, bw, childL, childW);
  if (!onParent || !onBoard || onParent.cpp >= onBoard.cpp) return null;
  return { declared: { l: pl, w: pw }, board: { l: bl, w: bw },
           cuts_declared: onParent.cpp, cuts_board: onBoard.cpp };
}

// A board change carries a parent that cannot stay (spec §4):
//   • a COPY of the OLD board's sheet — SW-544 kept 22×28, board #53's own
//     sheet, after moving to the 23×38 board #399;
//   • a size the NEW board cannot yield — the lock would only refuse it.
// Returns the new board's sheet to put in the parent fields (a fill the
// planner sees, saved only through the usual master/job question), or null
// to leave them alone: a blank parent already follows the board, and a
// genuine trim that still fits is the planner's to keep (the warnings speak
// if it costs cuts).
export function parentFollowsBoard(args) {
  const { parent, oldBoard, newBoard } = args ?? {};
  const nl = +newBoard?.l, nw = +newBoard?.w;
  if (!(nl > 0 && nw > 0)) return null;
  const copied = sameSheet(parent, oldBoard) && !sameSheet(oldBoard, newBoard);
  const tooBig = parentTooBig({ parentL: parent?.l, parentW: parent?.w, boardL: nl, boardW: nw });
  return copied || tooBig ? { l: nl, w: nw } : null;
}

// Two cuts nobody can measure are the same cut — neither can be said to have
// changed. Otherwise sameSheet: orientation-free, and unsized against sized is
// a change. Private to runSheetParent.
function sameCut(a, b) {
  const sized = s => +s?.l > 0 && +s?.w > 0;
  return !sized(a) && !sized(b) ? true : sameSheet(a, b);
}

// One field against the value on file, by VALUE: '22.0' is 22, blank is only
// blank, and a non-number compares NaN (so it stays an edit, and is said).
// Private to runSheetParent and engineParentError.
const sameValue = (a, b) => (blank(a) || blank(b)) ? blank(a) && blank(b) : Math.abs(+a - +b) < EPS;

// The Run Sheet's parent decision — ONE rule for whether the parent changed
// (it lights Lock sheet →) and for what Lock sheet → then sends, so the button
// and the payload can never disagree. (In review, 19 Sep 2026, two raw-string
// copies of this lit the button on a combined run whose orders already cut the
// same sheet.) Compared as EFFECTIVE sheets — what each member would actually
// cut on — so '23.0' and 38×23 are no change.
//   form      the Run Sheet fields { parent_l, parent_w } — strings, '' = blank
//   over      the one-click fill { parent_l, parent_w } (the board's own dims), or null
//   members   the run's members as MEMBER_VIEW sends them (parent_l/_w, sheet_l/_w)
//   isMerge   a combined run is one pile with one parent: every order is compared;
//             a gang compares its lead, whose values the Run Sheet shows
//   coPrinted a co-printed run's lock never reads a parent: none is ever sent
//   scope     the one-click's orders — the line ids of the red row it was
//             clicked on (Task 10). With `over`, ONLY those members are judged:
//             the first of them is the lead for this call, and the boards-differ
//             guard compares within them. Ignored without `over`: a typed
//             parent through Lock sheet → stays run-wide. Unscoped, the whole run.
// Returns { changed, error, parent }. `parent` is spread into the Lock sheet
// payload ({} sends nothing; the route reads that as "no change"); `error` is
// said INSTEAD of asking — input feedback, never a planning block. A half
// parent already on file, untouched, never blocks an unrelated lock; nor does
// an unsized board, untouched (two cuts nobody can measure are the same cut).
// On a combined run whose LEAD's own saved parent is flagged on its board —
// larger than it, or costing cuts — and untouched, an order that disagrees does
// not light the button: the red row and its one-click speak for it, and a
// coating-only lock must not spread the lead's parent onto an order already
// fixed. The one-click sends the parent ALONE to every order it covers, so it
// is said instead of asked when those orders' boards differ in size.
export function runSheetParent(args) {
  const { form, over, members, isMerge = false, coPrinted = false, scope = null } = args ?? {};
  const none = { changed: false, error: null, parent: {} };
  const forced = over?.parent_l != null && over?.parent_w != null;
  // The members this call judges. Run-wide, the one-click re-stamped EVERY
  // member's parent — on a gang of different products that overwrote
  // deliberate trims and wrote board-sheet copies into other masters (final
  // review, 19 Sep 2026) — so a scoped one-click judges its own orders alone.
  const pool = forced && Array.isArray(scope) ? (members || []).filter(m => scope.includes(m?.id)) : members;
  const lead = pool?.[0];
  if (coPrinted || !lead) return none;
  const boardOf = m => ({ sheet_l: m?.sheet_l, sheet_w: m?.sheet_w });
  // The one-click stamps one board's sheet on every order it covers without
  // moving any onto that board: an order on a board of another size would get a
  // parent it cannot yield (the lock refuses it; "Update Product Masters" would
  // write it). Compared by size, not id — two boards of one size both yield the
  // sheet.
  if (forced && pool.some(m => !sameCut({ l: m?.sheet_l, w: m?.sheet_w }, { l: lead.sheet_l, w: lead.sheet_w })))
    return { ...none, changed: true, error: 'This run\'s orders are on boards of different sizes — pick one board for the whole run (Smart Match or Manual) first, then use its full sheet' };
  const pl = forced ? over.parent_l : form?.parent_l;
  const pw = forced ? over.parent_w : form?.parent_w;
  const touched = forced || !sameValue(pl, lead.parent_l) || !sameValue(pw, lead.parent_w);
  if (touched && blank(pl) !== blank(pw))
    return { ...none, changed: true, error: 'Parent size needs both length and width — or leave both blank for the board\'s full sheet' };
  if (touched && ((!blank(pl) && !(+pl > 0)) || (!blank(pw) && !(+pw > 0))))
    return { ...none, changed: true, error: 'Parent size must be greater than zero' };
  // A half parent already on file means "no parent" to every cut: read it so.
  const halfOnFile = !touched && blank(pl) !== blank(pw);
  const ql = halfOnFile ? '' : pl, qw = halfOnFile ? '' : pw;
  // What a member would cut on under the typed parent, against what it cuts on
  // now — except a parent on file its board cannot yield: cutParentOf reads
  // that one as the board, so it is compared AS WRITTEN (the lock refuses it,
  // and blanking it must still send the board's sheet).
  const differs = m => (parentTooBig({ parentL: m?.parent_l, parentW: m?.parent_w, boardL: m?.sheet_l, boardW: m?.sheet_w })
    ? !sameSheet({ l: ql, w: qw }, { l: m.parent_l, w: m.parent_w })
    : !sameCut(cutParentOf({ parent_l: ql, parent_w: qw }, boardOf(m)), cutParentOf(m, boardOf(m))));
  const tooBig = touched && parentTooBig({ parentL: ql, parentW: qw, boardL: lead.sheet_l, boardW: lead.sheet_w });
  // Untouched, a combined run's lead whose own saved parent is flagged on its
  // board: a disagreeing order does not light the button (see above).
  const leadArgs = { parentL: lead.parent_l, parentW: lead.parent_w, boardL: lead.sheet_l, boardW: lead.sheet_w, childL: lead.child_l, childW: lead.child_w };
  const leadFlagged = !touched && (parentTooBig(leadArgs) || !!parentLosesCuts(leadArgs));
  const changed = forced || tooBig || (isMerge ? !leadFlagged && pool.some(differs) : differs(lead));
  if (!changed) return none;
  if (blank(ql) && blank(qw)) {
    // An unsized board is said only when the planner asked for its sheet;
    // untouched, it never blocks a coating or child lock.
    if (!(+lead.sheet_l > 0 && +lead.sheet_w > 0))
      return touched
        ? { ...none, changed: true, error: 'The run\'s board has no sheet size — set one board with a size for the whole run first' }
        : none;
    return { changed: true, error: null, parent: { parent_l: String(lead.sheet_l), parent_w: String(lead.sheet_w) } };
  }
  return { changed: true, error: null, parent: { parent_l: ql, parent_w: qw } };
}

// ── The single engine's parent, on the board's REAL sheet ───────────────────
// Task 7, review round 2 (19 Sep 2026). The single planning engine took its
// BOARD from LINE_VIEW's sheet_l/_w, which are the FOLDED parent — per side,
// COALESCE(job parent, master parent, board sheet) — so until a pick its
// "board" was the saved parent itself. SW-544's fossil 22×28 was measured
// against 22×28 and never warned, the one-click could write the fossil back,
// every pick "carried" a genuine trim away (SW-258's 22×28 on a 26×30 board),
// and Undo re-derived a parent instead of restoring the planner's. The engine
// now holds the board's own sheet (LINE_VIEW's board_sheet_l/_w) and these
// four decide the parent against it; single-engine-parent.test.js holds them.
// Like the twins above, every one accepts null arguments.

// The parent the single engine cuts on — the one plan-save will lock on.
//   form   the Parent L/W fields { parent_l, parent_w } — strings, '' = blank
//   saved  the parent on file { l, w }: LINE_VIEW's per-side
//          COALESCE(job override, master); either side may be null
//   board  the board's own sheet { l, w }
// It mirrors the server: per side, the typed value, else the saved one (the
// save's per-side COALESCE); then only a WHOLE pair is a parent, as in
// effectiveParent's "both sides, or the board". A blank field is "no change"
// to plan-save (changedSpec skips blanks), so it falls back to the SAVED
// parent, never to the board — reading it as the board counted cuts on a
// sheet the lock was never going to use.
// Returns { declared, parent }: `declared` is the pair, as numbers, whenever
// both sides are present — a side of zero or less INCLUDED, because
// effectiveParent only asks `!= null`: no cut fits such a sheet, so the lock
// issues 1:1 (childFit counts 1) and the screen, cutting on it, says the same
// through its unsized path. (Reading it as "no parent" showed the board's
// cuts over a lock issuing 1:1.) engineParentError below says a TYPED one at
// Save and Lock. `parent` is what the cut is measured on — the declared pair,
// else the board's own sheet.
export function engineParent(args) {
  const { form, saved, board } = args ?? {};
  const l = blank(form?.parent_l) ? saved?.l : form.parent_l;
  const w = blank(form?.parent_w) ? saved?.w : form.parent_w;
  const declared = !blank(l) && !blank(w) ? { l: +l, w: +w } : null;
  return { declared, parent: declared ?? { l: +board?.l, w: +board?.w } };
}

// Save and Lock in the single engine SAY a parent the planner typed that no
// cut can use, instead of saving it — the Run Sheet's two messages
// (runSheetParent), on the single engine's terms. Input feedback, never a
// planning block.
//   form, saved  as engineParent
// Judged on the pair plan-save would write — per side, the typed value, else
// the one on file (a blank field is "no change") — and ONLY when the planner
// touched it: a typed side that differs, by value, from the one on file. A
// half or zero parent already on file and untouched never blocks an unrelated
// Save or Lock; the screen shows what it cuts (1:1 for a zero side).
//   • half a parent — one side and not the other: the save would write that
//     half, and no cut ever reads one (residue on file, nothing more);
//   • a side of zero or less (or not a number): no sheet at all.
// A board-change fill or the one-click never trips it: over a parent on file
// they write both sides of a real sheet, and with nothing on file, blanks.
// Returns the message to say, or null.
export function engineParentError(args) {
  const { form, saved } = args ?? {};
  const l = blank(form?.parent_l) ? saved?.l : form.parent_l;
  const w = blank(form?.parent_w) ? saved?.w : form.parent_w;
  const touched = !sameValue(l, saved?.l) || !sameValue(w, saved?.w);
  if (!touched) return null;
  if (blank(l) !== blank(w))
    return 'Parent size needs both length and width — or leave both blank for the board\'s full sheet';
  if ((!blank(l) && !(+l > 0)) || (!blank(w) && !(+w > 0)))
    return 'Parent size must be greater than zero';
  return null;
}

// What "the board's full sheet" puts in the Parent fields.
//   saved  the parent on file { l, w } (as engineParent)
//   board  the board's own sheet { l, w }
// A parent on file (both sides): the board's dims, spelled out — a blank
// cannot clear a saved parent (to plan-save it is "no change"), and the Lock's
// master question then carries the new one (Update Product Master / This job
// only). Nothing on file, or only half a parent (which no cut reads): BLANKS.
// Blank IS the saved state there — no edit, no master question, and no copy of
// this board's sheet written down to turn into a fossil after the next board
// change, which is exactly what SW-544's 22×28 was (board #53's sheet, kept
// after the board moved on). An unsized board has no sheet to spell out, so it
// gets blanks too — they leave whatever is on file as it is.
export function boardSheetFill(args) {
  const { saved, board } = args ?? {};
  const bl = +board?.l, bw = +board?.w;
  return !blank(saved?.l) && !blank(saved?.w) && bl > 0 && bw > 0
    ? { parent_l: String(bl), parent_w: String(bw) }
    : { parent_l: '', parent_w: '' };
}

// A board change in the single engine: does the parent go with the board?
//   form, saved  as engineParent
//   from, to     the board being left and the board being picked, { l, w }
// The parent is the one the engine cuts on (engineParent, on the OLD board),
// and parentFollowsBoard decides it, as the run engine does: a copy of the old
// board's sheet, or a size the new board cannot yield, follows the board; a
// genuine trim the new board can still yield stays as it is — judged against
// the boards' own sheets, SW-258's 22×28 on a 26×30 is no copy of anything.
// What follows is boardSheetFill on the new board: its dims over a parent on
// file, blanks when none is.
// Returns { declared, carried, fill }; `fill` is null when the fields keep
// what they hold.
export function boardSwitch(args) {
  const { form, saved, from, to } = args ?? {};
  const { declared } = engineParent({ form, saved, board: from });
  const carried = parentFollowsBoard({ parent: declared, oldBoard: from, newBoard: to });
  const fill = carried ? boardSheetFill({ saved, board: to }) : null;
  return { declared, carried, fill };
}

// Undo of one board change: what goes back into the Parent fields.
//   form   the Parent L/W fields now
//   entry  the history entry the switch left: { board, parentBefore:
//          { parent_l, parent_w }, fill } — `fill` is what the switch wrote
//          into the fields, or null when it wrote nothing
// Undo restores what the switch changed; it never re-derives. When the switch
// wrote into the fields and they still hold EXACTLY that (as strings, the way
// it was written), the fields as they were before it come back. Otherwise
// null, and the fields are left alone: a switch that wrote nothing changed
// nothing, and an edit made since is the planner's. (Task 7 first re-ran the
// carry backwards, which turned a typed 22×36 into the old board's sheet, and
// a typed 22×28 into a carry nobody asked for.)
export function boardUndo(args) {
  const { form, entry } = args ?? {};
  const fill = entry?.fill;
  if (!fill) return null;
  const str = v => (v == null ? '' : String(v));
  const untouched = str(form?.parent_l) === str(fill.parent_l) && str(form?.parent_w) === str(fill.parent_w);
  return untouched ? (entry.parentBefore ?? null) : null;
}
