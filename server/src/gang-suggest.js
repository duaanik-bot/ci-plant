// Gang suggestions — the two questions a planner actually asks of the open
// queue, kept pure and db-free so the grouping rules can be unit tested:
//
//   1. "Which of my open jobs run on the same board?"  → one press run.
//   2. "Which of my open jobs ARE the same carton?"    → one die layout.
//
// Both are opportunities, never rules: the server treats every mismatch inside
// a gang as a warning (see gangCompat), so a suggestion only ever pre-fills the
// create modal — the planner still decides.

// Carton sizes were typed by hand across a decade of masters: "153X135X110",
// "160x63x108", "100 x 48 x 48", "5.5 x 3.5 x 2". Group on the NUMBERS, not on
// the punctuation, or one carton splits into three suggestions that each look
// too small to bother with. Every one of the 1,367 product masters carries
// exactly three dimensions, so anything else is a typo, not a carton — it gets
// no key rather than a wrong grouping.
export function sizeKey(size) {
  const nums = String(size ?? '').match(/\d+(?:\.\d+)?/g);
  if (!nums || nums.length !== 3) return null;
  return nums.map(n => String(+n)).join('x');   // "43.0 X 35 x 65" → "43x35x65"
}

// One spelling for a carton everywhere — same "×" the Tooling register uses.
export function sizeLabel(key) {
  return key ? key.split('x').join(' × ') : null;
}

const uniq = (arr, pick) => [...new Set(arr.map(pick).filter(v => v != null && v !== ''))];

function groupBy(arr, key) {
  const m = new Map();
  for (const x of arr) {
    const k = key(x);
    if (k == null) continue;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}

// Two suggestions built from the same jobs are the same suggestion — compare
// them on membership, not on the axis that happened to find them.
const fingerprint = group => group.map(m => m.id).sort((a, b) => a - b).join(',');

// Sort rank, not a boolean: 0 for a carton group that needs no decision before
// it can go to press, 1 for one that still has a board or coating to settle.
const runnable = s => (s.board_count === 1 && s.coating_count === 1 ? 0 : 1);

// Build both families of suggestion from the open planning lines. Returns ONE
// flat array (board groups first, biggest first, then carton groups) — each
// entry tagged with `kind` so a caller can band them, and shaped so the old
// board-only consumers keep reading exactly the fields they always did.
export function gangSuggestions(lines, { minJobs = 2, parentSheets = () => 0 } = {}) {
  const pack = (head, group) => ({
    ...head,
    line_ids: group.map(m => m.id),
    lines: group.map(m => ({
      id: m.id, product_name: m.product_name, product_code: m.product_code,
      po_number: m.po_number, qty: m.qty, delivery_date: m.delivery_date,
      board_name: m.board_name, coating: m.coating, carton_size: m.carton_size,
    })),
    total_parent_sheets: group.reduce((s, m) => s + parentSheets(m), 0),
  });

  // ── 1. Same board + coating — the classic shared press run ────────────────
  const board = [...groupBy(lines, l => `${l.board_material_id}|${l.coating}`).values()]
    .filter(g => g.length >= minJobs)
    .map(g => {
      // A board group that also happens to be ONE carton is the perfect nest:
      // same sheet, same die, same ups. Say so on the chip rather than
      // repeating the identical set of jobs as a second suggestion below. Every
      // member must carry a readable size — one blank master and the claim is
      // no longer true of the whole group.
      const keys = g.map(l => sizeKey(l.carton_size));
      const one = keys.every(k => k && k === keys[0]) ? keys[0] : null;
      return pack({
        kind: 'board',
        key: `board:${g[0].board_material_id}|${g[0].coating}`,
        board_material_id: g[0].board_material_id,
        board_name: g[0].board_name,
        coating: g[0].coating,
        size_key: one,
        size_label: sizeLabel(one),
      }, g);
    })
    .sort((a, b) => b.lines.length - a.lines.length);

  // ── 2. Same carton size — one die layout, whatever the board ──────────────
  // Boards may differ inside a carton group: that is the point of showing it.
  // The gang engine can set one shared board for the whole run, so "9 jobs are
  // the same carton, spread over 3 boards" is a consolidation the board axis
  // can never surface on its own.
  const covered = new Set(board.map(s => fingerprint(s.lines)));
  const size = [...groupBy(lines, l => sizeKey(l.carton_size)).entries()]
    .filter(([, g]) => g.length >= minJobs)
    .map(([k, g]) => {
      const boards = uniq(g, l => l.board_material_id);
      const coatings = uniq(g, l => l.coating);
      return pack({
        kind: 'size',
        key: `size:${k}`,
        size_key: k,
        size_label: sizeLabel(k),
        board_count: boards.length,
        coating_count: coatings.length,
        board_material_id: boards.length === 1 ? g[0].board_material_id : null,
        board_name: boards.length === 1 ? g[0].board_name : null,
        coating: coatings.length === 1 ? g[0].coating : null,
      }, g);
    })
    .filter(s => !covered.has(fingerprint(s.lines)))
    // Only three chips fit before the fold, so they must be the three the
    // planner can act on NOW: a carton group already down to one board and one
    // coating is a press run AND a die nest with no decision left in it. The
    // bigger cross-board groups are real opportunities too, just a board
    // decision away — they queue up behind, biggest first.
    .sort((a, b) => runnable(a) - runnable(b)
      || b.lines.length - a.lines.length
      || a.board_count - b.board_count
      || a.size_key.localeCompare(b.size_key));

  return [...board, ...size];
}
