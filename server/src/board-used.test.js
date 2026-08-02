import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { boardUsed } from '../../client/src/lib/boardUsed.js';

// The Job Card is the document that walks the floor, and until this module it
// was the ONLY surface in the plant that named the product master's board.
// Planning (orders.js EFF_BOARD_ID) and the Live Floor (floor.js STAGE_VIEW)
// both resolved the planner's warehouse pick; JC_VIEW hard-joined
// p.board_material_id — while its own `stk` lateral counted stock against the
// override. So a card could read "Board pending — short 4,000 sheets of FBB 300"
// while the number came from the Saffire the job had been moved onto, and the
// paper in the cutter's hand named a board nobody was cutting.

const jc = (over = {}) => ({
  board_material_id: 12, master_board_material_id: 12,
  board_name: 'FBB · 300 GSM · 31.5x41.5', master_board_name: 'FBB · 300 GSM · 31.5x41.5',
  board_grade: 'FBB', board_overridden: false,
  sheet_l: 31.5, sheet_w: 41.5, issues: [], ...over,
});

// ── master vs job board ───────────────────────────────────────────────
test('a job on its own master board reads as Master and says nothing more', () => {
  const b = boardUsed(jc());
  assert.equal(b.label, 'Master');
  assert.equal(b.differsFromMaster, false);
  assert.equal(b.name, 'FBB · 300 GSM · 31.5x41.5');
  assert.equal(b.sheet, '31.5×41.5"');
  assert.deepEqual(b.issuedElsewhere, []);
});

test('a planner override reads as Job Board and surfaces the master it left', () => {
  const b = boardUsed(jc({
    board_material_id: 88, board_name: 'Saffire · 300 GSM · 31.5x41.5',
    board_grade: 'Saffire', board_overridden: true,
  }));
  assert.equal(b.label, 'Job Board');
  assert.equal(b.differsFromMaster, true);
  assert.equal(b.name, 'Saffire · 300 GSM · 31.5x41.5');
  assert.equal(b.masterName, 'FBB · 300 GSM · 31.5x41.5');
});

// The ids are the truth, not the names: products.board_name is a denormalised
// copy that is stale on ~980 rows, and "FBB 300 GSM 31.5x41.5" /
// "FBB · 300 GSM · 31.5x41.5" are two spellings of ONE board.
test('two spellings of one board id do not read as a difference', () => {
  const b = boardUsed(jc({
    board_name: 'FBB · 300 GSM · 31.5x41.5',
    master_board_name: 'FBB 300 GSM 31.5x41.5',
  }));
  assert.equal(b.differsFromMaster, false, 'same material id = same board');
});

test('ids beat the override flag when they disagree', () => {
  // An override pinned back onto the master's own id is not a difference,
  // whatever the flag says.
  const b = boardUsed(jc({ board_overridden: true, board_material_id: 12, master_board_material_id: 12 }));
  assert.equal(b.differsFromMaster, false);
});

test('a payload with no ids falls back to the server flag', () => {
  const b = boardUsed({ board_name: 'X', board_overridden: true, issues: [] });
  assert.equal(b.differsFromMaster, true);
});

// ── the grade chip ────────────────────────────────────────────────────
// It is a separate fact from the board name — a carton specced "Saffire" can be
// linked to a "Duplex GB · 330 GSM" material and BOTH belong on the card. It is
// only noise when it repeats the name's first word, which is the exact reading
// ("Saffire · Saffire · 320 GSM · 31.5x41.5") called out as confusing once.
test('the grade chip survives when it says something the board name does not', () => {
  const b = boardUsed(jc({ board_grade: 'Saffire', board_name: 'Duplex GB · 330 GSM · 24.6x31.2' }));
  assert.equal(b.grade, 'Saffire');
});

test('the grade chip is dropped when it only repeats the board name', () => {
  assert.equal(boardUsed(jc({ board_grade: 'FBB', board_name: 'FBB · 290 GSM · 20x38' })).grade, null);
  assert.equal(boardUsed(jc({ board_grade: 'fbb', board_name: 'FBB · 290 GSM · 20x38' })).grade, null,
    'case must not resurrect it');
  assert.equal(boardUsed(jc({ board_grade: 'FBB', board_name: 'FBB 290 GSM 20x38' })).grade, null,
    'the legacy space-separated spelling reads the same way');
  assert.equal(boardUsed(jc({ board_grade: 'Duplex GB', board_name: 'Duplex GB · 330 GSM · 24.6x31.2' })).grade, null,
    'real grades run to two words — a first-word test would keep this chip');
});

// A job moved onto another board must take that board's grade. Reading the
// product master's board_grade there prints "SAFFIRE" beside an FBB board —
// the same stale-copy-contradicts-the-live-link failure this change exists to
// kill. The guard for the SQL side is in the JC_VIEW test below.
test('grade follows the board in use, not the master, once overridden', () => {
  const b = boardUsed(jc({
    board_material_id: 88, board_name: 'FBB · 290 GSM · 20x38', board_grade: 'FBB',
    master_board_name: 'Duplex GB · 330 GSM · 24.6x31.2',
  }));
  assert.equal(b.differsFromMaster, true);
  assert.equal(b.name, 'FBB · 290 GSM · 20x38');
});

// ── what the warehouse actually issued ────────────────────────────────
test('board issued as planned raises nothing', () => {
  const b = boardUsed(jc({
    issues: [{ material_id: 12, material_name: 'FBB · 300 GSM · 31.5x41.5', qty: -4000, unit: 'sheets' }],
  }));
  assert.deepEqual(b.issuedElsewhere, []);
});

test('a different material issued is named, with the total actually consumed', () => {
  const b = boardUsed(jc({
    issues: [
      { material_id: 12, material_name: 'FBB · 300 GSM · 31.5x41.5', qty: -1000, unit: 'sheets' },
      { material_id: 99, material_name: 'FBB · 280 GSM · 31.5x41.5', qty: -3000, unit: 'sheets' },
      { material_id: 99, material_name: 'FBB · 280 GSM · 31.5x41.5', qty: -200, unit: 'sheets' },
    ],
  }));
  assert.equal(b.issuedElsewhere.length, 1, 'one line per material, not per movement');
  assert.equal(b.issuedElsewhere[0].material_id, 99);
  assert.equal(b.issuedElsewhere[0].qty, 3200, 'summed, and positive — qty is stored negative');
  assert.equal(b.issuedElsewhere[0].unit, 'sheets');
});

// A cutting over-issue lands on a CUT-SHORT-<id> batch of the SAME material
// (helpers.js adjustBoardStock). It is a quantity story, never a board story —
// if it read as a different board every varied cutting would print a false alarm.
test('a CUT-SHORT over-issue is not a different board', () => {
  const b = boardUsed(jc({
    issues: [
      { material_id: 12, material_name: 'FBB · 300 GSM · 31.5x41.5', qty: -4000, unit: 'sheets' },
      { material_id: 12, material_name: 'FBB · 300 GSM · 31.5x41.5', qty: -150, unit: 'sheets', batch_no: 'CUT-SHORT-441' },
    ],
  }));
  assert.deepEqual(b.issuedElsewhere, []);
});

// A multi-board job (job_board_mix, phase='issued') deliberately finishes on
// several boards of a grade and carries its own reason per board — the printed
// card has a Board Mix table for exactly that. Reporting those as unplanned
// substitutions would print a false alarm on every deliberate mix.
test('a planned multi-board mix is not a substitution', () => {
  const b = boardUsed(jc({
    board_mix: [{ material_id: 12, board_name: 'FBB · 300 GSM · 31.5x41.5', sheets: 3000 },
                { material_id: 77, board_name: 'FBB · 300 GSM · 20x38', sheets: 1200, reason: 'short on the 31.5' }],
    issues: [
      { material_id: 12, material_name: 'FBB · 300 GSM · 31.5x41.5', qty: -3000, unit: 'sheets' },
      { material_id: 77, material_name: 'FBB · 300 GSM · 20x38', qty: -1200, unit: 'sheets' },
    ],
  }));
  assert.deepEqual(b.issuedElsewhere, [], 'every board drawn was in the plan');
});

test('a board outside BOTH the plan and the mix is still a substitution', () => {
  const b = boardUsed(jc({
    board_mix: [{ material_id: 77, board_name: 'FBB · 300 GSM · 20x38', sheets: 1200 }],
    issues: [
      { material_id: 77, material_name: 'FBB · 300 GSM · 20x38', qty: -1200, unit: 'sheets' },
      { material_id: 99, material_name: 'Duplex GB · 280 GSM · 20x38', qty: -800, unit: 'sheets' },
    ],
  }));
  assert.equal(b.issuedElsewhere.length, 1);
  assert.equal(b.issuedElsewhere[0].material_id, 99);
});

test('both divergences can be live at once', () => {
  const b = boardUsed(jc({
    board_material_id: 88, board_name: 'Saffire · 300 GSM · 31.5x41.5', board_overridden: true,
    issues: [{ material_id: 99, material_name: 'FBB · 280 GSM · 31.5x41.5', qty: -3000, unit: 'sheets' }],
  }));
  assert.equal(b.differsFromMaster, true);
  assert.equal(b.issuedElsewhere.length, 1);
});

// ── degenerate payloads ───────────────────────────────────────────────
test('survives a card with no board and no issues', () => {
  assert.equal(boardUsed(null), null);
  const b = boardUsed({});
  assert.equal(b.name, null);
  assert.equal(b.sheet, null);
  assert.deepEqual(b.issuedElsewhere, []);
});

// ── the guard on JC_VIEW itself ───────────────────────────────────────
// boardUsed() is only ever as right as the columns feeding it. If JC_VIEW ever
// goes back to naming p.board_material_id, every test above still passes and
// the plant silently prints the wrong board again.
test('JC_VIEW resolves the board being USED, not the product master', () => {
  const src = readFileSync(new URL('./routes/production.js', import.meta.url), 'utf8');
  const view = src.slice(src.indexOf('const JC_VIEW'), src.indexOf('async function attachTools'));

  assert.match(view, /LEFT JOIN materials ebm ON ebm\.id = COALESCE\(/,
    'JC_VIEW must join the effective board');
  assert.match(view, /COALESCE\(ol\.spec_override, gol\.spec_override\)->>'board_material_id'/,
    "the override must be read through gol too — a gang parent has no order line of its own");
  assert.match(view, /COALESCE\(ebm\.name, bm\.name\) AS board_name/,
    'board_name must be the board in use');
  assert.match(view, /COALESCE\(ebm\.sheet_l, bm\.sheet_l\) AS sheet_l/,
    'the parent sheet must follow the board in use, not the master');
  assert.match(view, /bm\.name AS master_board_name/,
    'the master must still be carried so the card can show the difference');
  assert.match(view, /p\.board_material_id AS master_board_material_id/,
    'the master id must be aliased — never left to shadow the effective id');
  assert.doesNotMatch(view, /^\s*p\.board_material_id,/m,
    'a bare p.board_material_id would ship the master as if it were the board in use');

  // The grade must branch on the override. p.board_grade is the product
  // master's own copy: correct on the master's board, and actively wrong on a
  // job board, where it prints "SAFFIRE" next to an FBB board.
  //
  // Anchored on the LAST CASE before the alias, not the first in the whole
  // view: JC_VIEW has other CASE expressions above this one (the gang's own
  // output/die numbers), and slicing from the first would drag their text —
  // and every column between — into the assertions below.
  const gradeEnd = view.indexOf('END AS board_grade');
  const grade = view.slice(view.lastIndexOf('CASE WHEN', gradeEnd), gradeEnd);
  assert.match(grade, /THEN COALESCE\(NULLIF\(ebm\.grade,''\)/,
    'an overridden board must take its grade from the material it actually is');
  assert.doesNotMatch(grade.slice(0, grade.indexOf('ELSE')), /p\.board_grade/,
    "the master's grade copy must not reach a job board");
});

test('both job-card issue reads carry material_id', () => {
  const src = readFileSync(new URL('./routes/production.js', import.meta.url), 'utf8');
  const reads = src.match(/SELECT sm\.qty, sm\.created_at, sm\.note[^\n]*/g) || [];
  assert.equal(reads.length, 2, 'the detail GET and the PUT response both build jc.issues');
  for (const r of reads) {
    assert.match(r, /sm\.material_id/,
      'without the id the card cannot tell whether what was issued is the board it names');
  }
});
