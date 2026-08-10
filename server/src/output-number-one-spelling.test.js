import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { outputNumberSql, GANG_RUN_MATES_LATERAL } from './helpers.js';

// ONE spelling of the OUTPUT NUMBER rule.
//
// The output (plate / positive) number is what the press, the sorter and the
// Press Line-up sheet call a job by. Three cases:
//
//   single line   → the product master's number, the job's override winning
//   CI-MRG- merge → the same, because a combined run is ONE product on several
//                   sales orders and there is only ever one plate set
//   CI-GANG- gang → the RUN's own number, and nothing falls back: several
//                   different cartons share that plate, so one member's master
//                   number would be a lie printed on the traveler
//
// That rule had been written by hand in four places and the four disagreed, in
// opposite directions:
//
//   · production.js /print-planning withheld the master from any card with no
//     order line of its own. The guard was aimed at mixed gangs, but a COMBINED
//     RUN's card has no order line either — so all eleven live CI-MRG- runs
//     printed a BLANK Output column on the board and on the Press Line-up sheet
//     the plant shares every evening, while the master carried the number the
//     whole time (CI-MRG-0001 → 18604, CI-MRG-0004 → 18603, CI-MRG-0003 →
//     18181, and three more that only the spec_override read recovers).
//   · production.js JC_VIEW, its `completed` query and floor.js STAGE_VIEW had
//     no such guard at all, so they fell back to the master for MIXED gangs —
//     the opposite error, and the one that puts a wrong number on paper.
//
// Both bugs are the same bug: the rule was stated as "does this card have a
// line of its own", which is a proxy, instead of "what KIND of run is this",
// which is the fact. helpers.js outputNumberSql states it once, on the kind.

const HERE = new URL('./', import.meta.url);

function sourceFiles(dir = HERE, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const u = new URL(e.name + (e.isDirectory() ? '/' : ''), dir);
    if (e.isDirectory()) sourceFiles(u, out);
    else if (e.name.endsWith('.js') && !e.name.endsWith('.test.js'))
      out.push([e.name, readFileSync(u, 'utf8')]);
  }
  return out;
}

const sqlBlocks = (src) => src.split('`').filter((_, i) => i % 2 === 1);

// ── the rule itself ───────────────────────────────────────────────────
const CARD = () => outputNumberSql({ override: `COALESCE(ol.spec_override, gol.spec_override)->>'output_number'` });

test('a named gang answers to the RUN’s number', () => {
  assert.match(CARD(), /CASE WHEN gg\.kind = 'gang' THEN NULLIF\(gg\.output_number, ''\) END/,
    'a mixed layout is plated for that run alone, so the run names the job');
});

test('a mixed gang NEVER falls back to a member’s master number', () => {
  const sql = CARD();
  const arm = sql.indexOf(`IS DISTINCT FROM 'gang'`);
  assert.ok(arm > 0, 'the fallback arm must be guarded on the run kind');
  // Every reference to a master / override value has to sit INSIDE that arm.
  for (const ref of ['p.output_number', 'spec_override']) {
    assert.ok(sql.indexOf(ref) > arm,
      `${ref} appears outside the non-gang arm — a gang would then print one `
      + 'member’s plate number on a sheet carrying several others');
  }
});

test('an UNNAMED gang resolves to nothing rather than to a member', () => {
  // Both arms are CASEs, so when kind='gang' and the run has no number the
  // whole COALESCE is NULL. A blank Output column is the honest answer; the
  // planner has not named the plate set yet.
  const sql = CARD();
  assert.doesNotMatch(sql, /END\s*,\s*NULLIF\(p\.output_number/,
    'a bare master fallback after the gang arm is exactly the bug — it fires '
    + 'precisely when the gang has NOT been named, which is when it is most wrong');
});

test('a COMBINED RUN is not excluded — it keeps its master’s number', () => {
  const sql = CARD();
  assert.doesNotMatch(sql, /order_line_id/,
    'gating on whether the card owns an order line is what blanked every '
    + 'CI-MRG- run: a combined-run card has no line of its own either, and it '
    + 'is a single product that does have a plate number');
  assert.match(sql, /IS DISTINCT FROM 'gang'/,
    'merge and solo take the same arm — one product, one master plate');
});

test('the job’s own override outranks the product master', () => {
  const sql = CARD();
  const ov = sql.indexOf('spec_override');
  const master = sql.indexOf('p.output_number');
  assert.ok(ov > 0 && ov < master,
    'Planning and Artwork edit the override; the board was the last screen '
    + 'still reading past it to the master');
});

test('a call site with no override to read still resolves', () => {
  const sql = outputNumberSql();
  assert.match(sql, /NULLIF\(p\.output_number, ''\)/);
  assert.doesNotMatch(sql, /spec_override/);
});

// ── no second spelling ────────────────────────────────────────────────
// The shape every hand-rolled copy had: a COALESCE opening on the gang CASE.
// `run_output_number` selects that CASE on its own, deliberately — it is the
// "has this run been named yet" signal, not the resolution — so it is bare and
// does not match.
const HAND_ROLLED = /COALESCE\(\s*CASE WHEN \w+\.kind = 'gang' THEN NULLIF\(\w+\.output_number/;

test('no query re-derives the output-number rule inline', () => {
  for (const [name, src] of sourceFiles())
    for (const block of sqlBlocks(src))
      assert.doesNotMatch(block, HAND_ROLLED,
        `${name}: this is helpers.js outputNumberSql written again by hand. The four `
        + 'copies that existed before disagreed with each other in both directions, and '
        + 'nothing looked broken until a combined run reached a press');
});

test('the guard finds the real call sites', () => {
  // A guard that matches nothing passes forever. Pin who actually uses it.
  const users = sourceFiles()
    .filter(([, src]) => src.includes('outputNumberSql('))
    .map(([n]) => n).sort();
  assert.deepEqual(users, ['extrasheets.js', 'floor.js', 'helpers.js', 'orders.js', 'plates.js', 'production.js'],
    'the job card + press board (production.js), the station queues (floor.js) and '
    + 'the planning/artwork line views (orders.js), and Extra Sheets are every screen that names a job '
    + 'by its plate number — and plates.js, where the number IS the subject: the Plate PR, '
    + 'its PO and its GRN all name the plate set by it');
});

test('the plate module does not keep its own output-number rule', () => {
  // plates.js spelled it `spec -> gang -> master`, which is the second of the two
  // opposite errors this guard was written for: the master tail fires precisely
  // when the gang has NOT been named, so an unnamed gang's Plate PR, PO and GRN
  // all printed ONE member carton's number on a sheet carrying several others.
  const src = readFileSync(new URL('./routes/plates.js', HERE), 'utf8');
  assert.doesNotMatch(src, /NULLIF\(gr\.output_number,\s*''\),\s*p\.output_number/,
    'this is the hand-rolled plate spelling — use outputNumberSql()');
  assert.equal((src.match(/outputNumberSql\(/g) || []).length, 3,
    'the requirement list, the PO register and the GRN register each name the job');
});

test('a PLATE answers to the number stamped on it, not to a live lookup', () => {
  // The job-side rule resolves live because a job's number can still be edited.
  // A plate cannot: plate_assets.output_number is stamped at GRN and is what is
  // physically associated with the aluminium. Different question, so a different
  // rule — but still ONE spelling of it, or the rack and the returns queue drift.
  const src = readFileSync(new URL('./routes/plates.js', HERE), 'utf8');
  assert.equal((src.match(/const ASSET_OUTPUT_NUMBER =/g) || []).length, 1);
  assert.equal((src.match(/\$\{ASSET_OUTPUT_NUMBER\(/g) || []).length, 4,
    'the warehouse, the returns queue, the movement history and the single-asset '
    + 'fetch all describe the same physical plate');
  // And it refuses the master to a gang, for the same reason the job rule does.
  const fn = src.slice(src.indexOf('const ASSET_OUTPUT_NUMBER ='));
  assert.match(fn.slice(0, fn.indexOf('\n\n')), /is_gang'\)::boolean,false\)\s*\n?\s*THEN NULL ELSE NULLIF\(p\.output_number/,
    'a gang plate must resolve to blank rather than to a member master');
});

test('production.js resolves it for the live board AND the completed list', () => {
  const src = readFileSync(new URL('./routes/production.js', HERE), 'utf8');
  assert.equal((src.match(/outputNumberSql\(/g) || []).length, 3,
    'JC_VIEW, /print-planning cards and /print-planning completed — a finished gang '
    + 'reported one member’s master number as the run’s plate until all three agreed');
});

// ── provenance after the sheet is cut apart ───────────────────────────
// A mixed gang travels as one card to die cutting, then splitGangParentJob
// mints a child card per carton for sorting, pasting and QC. The child keeps
// gang_run_id, so it still knows its run NUMBER — but the members roll-up
// fires only on the parent, so the number lost everything that made it mean
// something. GANG_RUN_MATES_LATERAL is the other half.

test('the mates lateral fires only for a card that has SPLIT off a run', () => {
  assert.match(GANG_RUN_MATES_LATERAL, /jc\.parent_job_card_id IS NOT NULL/,
    'a parent has the full members roll-up already; giving it mates too would '
    + 'render a gang as both a unified row and a split one');
  assert.match(GANG_RUN_MATES_LATERAL, /jc\.gang_run_id IS NOT NULL/,
    'a solo job was never in a run');
});

test('a card is not listed as its own sheet-mate', () => {
  assert.match(GANG_RUN_MATES_LATERAL, /olm\.id IS DISTINCT FROM jc\.order_line_id/,
    'IS DISTINCT FROM, not <>: against a NULL order_line_id `<>` is NULL for every '
    + 'row, so the whole list would silently come back empty instead of complete');
});

test('every floor view that shows a gang also shows where a split card came from', () => {
  const src = readFileSync(new URL('./routes/floor.js', HERE), 'utf8');
  const members = (src.match(/gm\.members AS gang_members/g) || []).length;
  const mates = (src.match(/rmate\.mates AS gang_run_mates/g) || []).length;
  assert.ok(members >= 4, `expected the four station/floor views, found ${members}`);
  assert.equal(mates, members,
    'the two halves of a run’s identity are added together — the parent’s unified '
    + 'row and the split child’s provenance. A queue with one and not the other is '
    + 'how the gang number came to mean nothing the moment the sheet was cut');
});

test('the job card carries the provenance too', () => {
  const src = readFileSync(new URL('./routes/production.js', HERE), 'utf8');
  assert.match(src, /rmate\.mates AS gang_run_mates/,
    'the traveler is the paper that walks the floor after die cutting — the sheet '
    + 'it came off is not standing next to it any more');
  assert.match(src, /\$\{GANG_RUN_MATES_LATERAL\}/,
    'and it takes the lateral from the helper rather than spelling it again');
});
