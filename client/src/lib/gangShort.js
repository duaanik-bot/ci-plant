// Is the run short right now, and by how much.
//
// ONE spelling, in a plain module, because three readers quote it — the dialog
// footer, the Board Position card and the Lock button — and the arithmetic used
// to live inline in Planning.jsx where `node --test` cannot reach it. Same
// reason lib/boardShort.js and lib/boardPositionView.js sit apart from the .jsx
// that renders them.
//
// The figure the server sends is measured against the SAVED mix. The planner is
// looking at a DRAFT: the Board Mix panel is open, its rows are being typed, and
// its own totals already say "Fully covered". So the client cannot read the
// server's verdict and must re-apply the server's RULE to what is on screen —
// which is the whole reason pressingOnPlanned is mirrored here.
const num = v => (Number.isFinite(+v) ? +v : 0);

// What a run's issue actually presses on its PLANNED board — the twin of
// server/src/gang-mix.js's function of the same name, kept literally identical.
//
// Without a mix that is the whole requirement. With one it is the sheets written
// against the planned board plus whatever the mix has NOT covered: a substitute
// is never "needed" beyond what is written against it, and only the planned
// board carries the unmet remainder.
export function pressingOnPlanned({ required, active, covered = 0, heldOnPlanned = 0 }) {
  const req = num(required);
  if (!active) return req;
  return num(heldOnPlanned) + Math.max(0, req - num(covered));
}

// The run's shortfall, its lead board and every other board its members run on.
//
// `mixCovered` arrives as a number rather than being derived here: it comes from
// mixTotals, which lives in a .jsx and would drag the whole component tree into
// a unit test. The caller already holds it for the panel's own totals.
export function gangShortView({
  position = null,
  otherBoardPositions = [],
  stockBooking = 'book',
  sharedMode = false,
  issueNow = 0,
  mixRows = [],
  plannedBoardId = null,
  mixCovered = 0,
} = {}) {
  const onOrder = position?.incoming ?? 0;
  const freshRun = (stockBooking || 'book') === 'fresh_pr';
  const heldRun = position?.held ?? 0;
  const avail = position?.available ?? 0;
  const other = (position?.committed_other ?? 0) + (position?.held_others ?? 0);

  // The mix as it stands ON SCREEN, not as it was last saved.
  const active = mixRows.length > 0;
  const heldOnPlanned = mixRows
    .filter(r => Number(r.material_id) === Number(plannedBoardId))
    .reduce((s, r) => s + num(r.sheets), 0);

  // The LEAD board answers for its OWN members' sheets, not the whole run's —
  // the server scopes it that way and gives every other board its own entry in
  // other_board_positions. `needed_gross` is that scoping BEFORE any mix credit,
  // which is exactly what this function must re-credit from the live draft;
  // `position.needed` is the same figure with the SAVED mix already taken off
  // and would double-count. A shared (co-printed) layout is the exception by
  // construction: one sheet prints every member, so the run figure IS the lead
  // board's — and it tracks the live issue, override and all.
  const leadGross = sharedMode ? num(issueNow) : num(position?.needed_gross ?? issueNow);
  const leadShare = pressingOnPlanned({
    required: leadGross, active, covered: mixCovered, heldOnPlanned,
  });

  // A fresh_pr run refuses the shelf outright: its still-to-buy is the full
  // requirement less its own PR and the stock already held for it.
  const short = freshRun
    ? Math.max(0, leadShare - heldRun - onOrder)
    : Math.max(0, leadShare + other - avail - onOrder);

  // Boards the other members run on, each with its own shortfall — a two-board
  // gang stopped hiding the second board's gap inside the first's surplus the
  // moment the server started answering per board.
  const otherBoards = (otherBoardPositions || [])
    .map(b => ({
      board_material_id: b.board_material_id,
      board_name: b.board_name,
      short: Math.max(0, num(b.position?.short)),
    }))
    .filter(b => b.short > 0);

  return {
    short, freshRun, onOrder, otherBoards,
    totalShort: short + otherBoards.reduce((s, b) => s + b.short, 0),
    free: Math.max(0, avail - other),
  };
}
