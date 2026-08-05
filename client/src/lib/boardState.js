// Collapsing a board verdict — the arithmetic behind the plant's board
// vocabulary, kept apart from how it LOOKS.
//
// `components/BoardStatus.jsx` owns the words, tones and icons and re-exports
// everything here, so every screen still imports the vocabulary from one place.
// The rule itself lives in lib/ for one reason: BoardStatus.jsx holds JSX and
// cannot be imported by a node test, so for as long as the collapse lived in
// there it could only ever be grepped, never executed. It decides what a
// planner sees about board on two queues; it is worth a test.
//
// The server resolves the verdict for a row it grouped itself. Planning and
// Artwork group gangs CLIENT-side, so for them it cannot have — hence this.

export const BOARD_RANK = { short: 0, on_order: 1, covered: 2 };   // worst first

// A gang runs as ONE sheet, so its weakest member decides for the whole run.
//
// `fallback(member)` decides what a member carrying NO `board_state` reads as —
// an older payload served mid-deploy, and the one place the two queues
// genuinely differ:
//
//   Artwork   the default, 'covered'. That queue has no other board signal, and
//             a stale response must not paint the whole page red.
//   Planning  its own board gate (`readiness.material`), because a Planning row
//             carries readiness. Defaulting to covered there would hide a
//             genuinely short job on the one screen whose job is to fix it.
//
// It is a parameter rather than two readers because everything else about the
// collapse — the ranking, the worst-wins reduce, the empty case — must not be
// allowed to drift between them. It was two readers, and it did.
export const worstBoardStateOf = (rows, fallback) => (rows || [])
  .map(m => m.board_state || (fallback ? fallback(m) : 'covered'))
  .reduce((worst, s) => (BOARD_RANK[s] < BOARD_RANK[worst] ? s : worst), 'covered');

// The verdict for a QUEUE ROW on a screen that groups gangs itself: a grouped
// run arrives as a synthetic row carrying its members on `_gang`, anything else
// stands for itself. An empty `_gang` reads 'covered' rather than falling back
// to the wrapper — a grouped row with no members is a bug upstream, and the
// wrapper's own fields are not a member's verdict.
export const rowBoardStateOf = (row, fallback) =>
  worstBoardStateOf(row?._gang || (row ? [row] : []), fallback);
