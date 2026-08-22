import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cutsOn, gateSubstitution, judge, parentsFor, rankOptions } from './xs-board-options.js';

// Real rows, live plant, 2026-08-22. CI-XS-0004 sits on CI-JC-0159 (FLORA ZN
// SACHETS): a 15.75×20.75″ child off a 31.5×41.5″ parent — exactly 4 up — on
// board 56. Every board below is on the shelf right now, so the arithmetic in
// these tests is arithmetic the plant can walk out and verify.
const PRODUCT = { child_l: 15.75, child_w: 20.75, parent_l: 31.5, parent_w: 41.5 };
const B = (id, name, grade, gsm, l, w, shelf, free) =>
  ({ id, name, grade, gsm, sheet_l: l, sheet_w: w, category: 'board', active: 1,
     sheets_per_packet: 144, leftover: 0, shelf, free: free ?? shelf });

const PLANNED  = B(56,  'Duplex WB · 350 GSM · 31.5x41.5', 'Duplex WB', 350, 31.5, 41.5, 2875, 2875);
const LIGHTER  = B(364, 'Duplex WB · 296 GSM · 31.5x41.5', 'Duplex WB', 296, 31.5, 41.5, 1711, 1711);
const CROSS    = B(95,  'FBB · 290 GSM · 31.5x41.5',       'FBB',       290, 31.5, 41.5, 2332, 2332);
const SMALLER  = B(289, 'Duplex WB · 350 GSM · 25x36',     'Duplex WB', 350, 25,   36,   2588, 2588);
// Not a purchased board: no sheet in the live master is smaller than a
// 15.75×20.75″ print sheet, and the smallest that exists (FBB 19×25) still
// yields one. An offcut strip is the shape that actually reaches this rule.
const OFFCUT   = B(900, 'Offcut strip · 12x20',            'FBB',       340, 12,   20,   4400, 4400);
const TINY     = B(361, 'FBB · 340 GSM · 19x25',           'FBB',       340, 19,   25,   4400, 4400);

test('the planned board, judged against itself, carries no consequences', () => {
  const v = judge(PLANNED, { planned: PLANNED, product: PRODUCT, needed: 50, plannedCuts: 4 });
  assert.equal(v.planned, true);
  assert.equal(v.kind, 'planned');
  assert.equal(v.cuts, 4, '31.5×41.5 parent, 15.75×20.75 child — 2 across, 2 down');
  assert.equal(v.yield_sheets, 200);
  assert.deepEqual(v.cautions, []);
  assert.equal(v.blocked, false);
  assert.equal(v.short, false);
});

test('same grade and size, one GSM lighter — usable, and it says exactly what moved', () => {
  const v = judge(LIGHTER, { planned: PLANNED, product: PRODUCT, needed: 50, plannedCuts: 4 });
  assert.equal(v.blocked, false);
  assert.equal(v.kind, 'grade', 'same grade, caliper moved — not an exact match, not a different grade');
  assert.equal(v.cuts, 4, 'the sheet is the same size, so the cut is unchanged');
  assert.equal(v.yield_sheets, 200);
  const axes = v.cautions.map(c => c.axis);
  assert.deepEqual(axes, ['gsm'], 'only the caliper moved — do not cry about grade or size');
  assert.match(v.cautions[0].text, /296 GSM against the planned 350 GSM/);
  assert.match(v.cautions[0].text, /lighter/);
});

test('a different grade is offered, never silently — the carton stops matching the run', () => {
  const v = judge(CROSS, { planned: PLANNED, product: PRODUCT, needed: 50, plannedCuts: 4 });
  assert.equal(v.blocked, false, 'FBB 31.5×41.5 cuts this job perfectly well — physics does not refuse it');
  assert.equal(v.kind, 'cross');
  assert.ok(v.cautions.some(c => c.axis === 'grade'));
  assert.match(v.cautions.find(c => c.axis === 'grade').text, /will not match the rest of the run/);
});

// THE ONE THAT COSTS MONEY. 50 parents of the planned board is 200 print
// sheets; 50 parents of the 25×36 is 100. Approve the same 50 and the press is
// still 100 short — and nobody finds out until the press stops a second time.
test('a smaller sheet re-states the yield instead of quietly halving it', () => {
  const v = judge(SMALLER, { planned: PLANNED, product: PRODUCT, needed: 50, plannedCuts: 4 });
  assert.equal(v.blocked, false);
  assert.equal(v.parent_fits, false, '31.5×41.5 does not trim out of 25×36');
  assert.equal(v.cuts, 2, 'the 25×36 sheet itself goes under the guillotine — 2 children off it');
  assert.equal(v.yield_sheets, 100, '50 parents × 2, NOT 50 × 4');
  const cuts = v.cautions.find(c => c.axis === 'cuts');
  assert.ok(cuts, 'a changed cut count is the loudest thing on this screen');
  assert.match(cuts.text, /50 parents of this board yield 100 print sheets, not 200/);
  assert.match(cuts.text, /Re-check the quantity/);
});

test('parentsFor answers the question the approver actually has', () => {
  // "I was 200 print sheets short and this board only cuts 2 up."
  assert.equal(parentsFor(200, 2), 100);
  assert.equal(parentsFor(200, 4), 50);
  assert.equal(parentsFor(199, 4), 50, 'a part parent is still a whole parent off the shelf');
  assert.equal(parentsFor(0, 4), null);
  assert.equal(parentsFor(200, 0), null);
});

test('a sheet too small for even one print sheet is refused, and no reason buys it', () => {
  const v = judge(OFFCUT, { planned: PLANNED, product: PRODUCT, needed: 50, plannedCuts: 4 });
  assert.equal(v.blocked, true);
  assert.equal(v.cuts, 0);
  assert.match(v.block_reason, /no guillotine enlarges board/);

  const gate = gateSubstitution({
    candidate: OFFCUT, planned: PLANNED, product: PRODUCT, needed: 50, plannedCuts: 4,
    reason: 'nothing else on the floor', override: true,
  });
  assert.equal(gate.ok, false, 'physics is not overridable — not by a reason, not by the plant head');
  assert.ok(gate.blockers.some(b => /enlarges board/.test(b)));
});

// The smallest board the plant actually stocks. It is a BAD answer — one print
// sheet off a whole 19×25 sheet — and it is still a real one at 2am, so it is
// offered with its cost stated rather than hidden behind a refusal.
test('the smallest real board is offered at its true, terrible yield', () => {
  const v = judge(TINY, { planned: PLANNED, product: PRODUCT, needed: 50, plannedCuts: 4 });
  assert.equal(v.blocked, false);
  assert.equal(v.cuts, 1, '19×25 yields exactly one 15.75×20.75 print sheet');
  assert.equal(v.yield_sheets, 50, '50 parents buy 50 print sheets here, not 200');
  assert.match(v.cautions.find(c => c.axis === 'cuts').text, /yield 50 print sheets, not 200/);
});

test('an empty shelf is refused before anything else is measured', () => {
  const v = judge(B(999, 'Saffire · 340 GSM · 20x34', 'Saffire', 340, 20, 34, 0, 0),
    { planned: PLANNED, product: PRODUCT, needed: 50, plannedCuts: 4 });
  assert.equal(v.blocked, true);
  assert.match(v.block_reason, /Nothing on the shelf/);
});

// The user's actual sentence: "i might have no stock or frozen for some other
// job stock but i could use 50-100 sheets".
test('board booked to another job is offered, but only the plant head may take it', () => {
  const frozen = B(47, 'Duplex WB · 320 GSM · 31.5x41.5', 'Duplex WB', 320, 31.5, 41.5, 1004, 0);
  const v = judge(frozen, { planned: PLANNED, product: PRODUCT, needed: 50, plannedCuts: 4 });
  assert.equal(v.blocked, false, 'the sheets exist — this is a booking question, not a physics one');
  assert.equal(v.short, true);
  assert.equal(v.beyond_shelf, false);
  assert.equal(v.committed_elsewhere, 1004);
  assert.match(v.short_reason, /already booked to other jobs/);

  const args = { candidate: frozen, planned: PLANNED, product: PRODUCT, needed: 50, plannedCuts: 4 };
  assert.equal(gateSubstitution({ ...args, reason: 'press down' }).ok, false,
    'without the override it stays refused — a booked sheet is somebody else\'s');
  assert.equal(gateSubstitution({ ...args, reason: 'press down', override: true }).ok, true,
    'with the override and a reason the plant head may break into it');
  assert.equal(gateSubstitution({ ...args, reason: '   ', override: true }).ok, false,
    'the override alone is not a decision — the job it robs needs a name on it');
});

test('board that does not physically exist cannot be conjured by an override', () => {
  const thin = B(141, 'FBB · 350 GSM · 22x28', 'FBB', 350, 22, 28, 30, 30);
  const gate = gateSubstitution({
    candidate: thin, planned: PLANNED, product: PRODUCT, needed: 50, plannedCuts: 4,
    reason: 'nothing else', override: true,
  });
  assert.equal(gate.ok, false);
  assert.ok(gate.blockers.some(b => /physically on the shelf/.test(b)),
    'the override releases committed stock, never stock that is not there');
});

test('a substitution with no reason is refused however good the board is', () => {
  const gate = gateSubstitution({
    candidate: LIGHTER, planned: PLANNED, product: PRODUCT, needed: 50, plannedCuts: 4, reason: '',
  });
  assert.equal(gate.ok, false);
  assert.ok(gate.blockers.some(b => /Say why the planned board is not being used/.test(b)));
  assert.equal(gateSubstitution({
    candidate: LIGHTER, planned: PLANNED, product: PRODUCT, needed: 50, plannedCuts: 4,
    reason: 'planned board frozen for CI-JC-0161',
  }).ok, true);
});

test('the planned board itself needs no substitution reason', () => {
  const gate = gateSubstitution({
    candidate: PLANNED, planned: PLANNED, product: PRODUCT, needed: 50, plannedCuts: 4, reason: '',
  });
  assert.equal(gate.ok, true, 'approving on the planned board must stay exactly as easy as it was');
});

test('cutting takes parents away as parents — the yield is not multiplied there', () => {
  const v = judge(LIGHTER, { planned: PLANNED, product: PRODUCT, needed: 50, plannedCuts: 4, stage: 'cutting' });
  assert.equal(v.yield_sheets, 50, 'a cutting stage receives the parent sheets themselves');
});

test('rank puts the planned board first, then what covers the need, closest grade first', () => {
  const opts = [CROSS, SMALLER, LIGHTER, PLANNED, OFFCUT].map(c =>
    judge(c, { planned: PLANNED, product: PRODUCT, needed: 50, plannedCuts: 4 }));
  const order = rankOptions(opts, 50).map(o => o.id);
  assert.equal(order[0], 56, 'the approver must see WHY he is being offered alternatives, first');
  assert.equal(order[order.length - 1], 900, 'a board that cannot cut the job belongs at the bottom');
  assert.ok(order.indexOf(364) < order.indexOf(95),
    'same grade, lighter GSM beats a different grade with MORE stock on the shelf');
});

test('a board that covers the need outranks a closer one that does not', () => {
  const starved = { ...LIGHTER, free: 10 };            // perfect board, 10 free
  const plenty = { ...CROSS, free: 2332 };             // wrong grade, plenty
  const opts = [starved, plenty].map(c =>
    judge(c, { planned: PLANNED, product: PRODUCT, needed: 50, plannedCuts: 4 }));
  const order = rankOptions(opts, 50).map(o => o.id);
  assert.deepEqual(order, [95, 364],
    'ten free sheets do not solve a fifty-sheet problem, however well the board matches');
});

// ── Wiring: the route and the page must actually use all of the above ──────
const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');
const route = read('./routes/extrasheets.js');
const page = read('../../client/src/pages/ExtraSheets.jsx');

test('the approve route re-derives the verdict rather than trusting the dialog', () => {
  assert.match(route, /import \{[^}]*gateSubstitution[^}]*\} from '\.\.\/xs-board-options\.js'/);
  assert.match(route, /gateSubstitution\(\{/,
    'the same pure gate the picker rendered must run inside the transaction');
  assert.match(route, /r\.get\('\/extra-sheets\/:id\/board-options'/);
});

test('the approve route stores the chosen board and the cuts THAT board makes', () => {
  // The planned board's chosen cuts come from job_board_mix, which holds no row
  // for a substitute. Storing geometry-derived cuts is what keeps the parent →
  // print-sheet conversion honest for the rest of the request's life.
  // job_board_mix holds no row for a board nobody planned, so plannedCutsForJob
  // returns the legacy cpp for a substitute — the PLANNED board's number. The
  // substitute's cuts must come off the verdict's geometry instead.
  assert.match(route, /const cuts = substituting\s*\n\s*\? Math\.max\(1, gate\.verdict\.cuts\)\s*\n\s*: await plannedCutsForJob\(oc, jc, chosenId\);/,
    'a substitute board\'s cuts are geometry; the planned board keeps its chosen-mix count');
  assert.match(route, /board_material_id=\$4, cuts_per_parent=\$5/);
});

test('a substitution is loud in the audit trail, not a silent column change', () => {
  assert.match(route, /extra_sheet_board_substituted/);
  assert.match(route, /substitute_reason/);
});

// THE REPORTING BUG THIS FEATURE WOULD OTHERWISE SHIP. XS_VIEW read every
// descriptive and stock column off `bm` — the PLANNED board — while
// board_material_id already coalesced to x.board_material_id. Substitute a
// board and Cutting is handed a slip naming the board that was NOT consumed.
test('XS_VIEW reports the board that will actually be consumed', () => {
  assert.match(route, /LEFT JOIN materials xbm ON xbm\.id = x\.board_material_id/,
    'the effective board needs its own join — bm is the planned board and stays that');
  assert.match(route, /COALESCE\(xbm\.name, bm\.name\) AS board_name/);
  assert.match(route, /COALESCE\(xbm\.gsm, bm\.gsm\) AS board_gsm/);
  assert.match(route, /COALESCE\(xbm\.sheet_l, bm\.sheet_l\) AS parent_l/);
  assert.match(route, /COALESCE\(xbm\.sheet_w, bm\.sheet_w\) AS parent_w/);
  assert.match(route, /bm\.name AS planned_board_name/,
    'the planned board must stay visible — "substituted FROM" is the whole story');
  assert.match(route, /COALESCE\(x\.board_material_id, bm\.id\)/);
});

test('the stock position on a substituted request follows the substituted board', () => {
  // av/lk keyed on bm.id reported the PLANNED board's shelf against a request
  // that will eat a different one — a free figure about the wrong pile.
  assert.match(route, /WHERE sb\.material_id = COALESCE\(x\.board_material_id, bm\.id\)/);
  assert.match(route, /WHERE d\.material_id = COALESCE\(x\.board_material_id, bm\.id\)/);
});

test('the approve dialog offers the warehouse and shows what each board costs', () => {
  assert.match(page, /board-options/);
  assert.match(page, /Pick from warehouse/);
  assert.match(page, /substitute_reason/);
  assert.match(page, /allow_committed/);
  assert.match(page, /block_reason/, 'a board the job cannot use must say why, not just sit dead');
  assert.match(page, /cautions\.map/, 'what changes on the floor is shown, not summarised away');
});

// The yield is the number the press cares about, and it has to move while the
// plant head trims the quantity — a figure fetched once at the requested qty is
// wrong the moment he types. So the dialog recomputes it with the SERVER's own
// formula (parents × that board's cuts, except at Cutting) rather than reading
// the fetch-time yield_sheets field back.
test('the dialog recomputes the print-sheet yield live, on the server formula', () => {
  assert.match(page, /const yieldOf = \(opt, qty, stage\) =>/);
  assert.match(page, /stage === 'cutting' \? Math\.max\(0, qty\) : Math\.max\(0, qty\) \* Math\.max\(1, opt\?\.cuts \|\| 1\)/,
    'same conditional the route and the issue path use — cutting takes parents as parents');
  assert.match(page, /print sheets at the press/);
  assert.match(page, /const matchParents/,
    'when the cuts move, the approver needs the parent count that buys what was asked for');
});

test('the row converts parents to print sheets on the board that will be CUT', () => {
  // planned_cuts is the PLANNED board's mix count. On a substituted request it
  // is the wrong number, and it is the number this row used to print.
  assert.match(page, /r\.effective_cuts \|\| r\.planned_cuts \|\| r\.children_per_parent/);
  assert.match(page, /board_substituted/, 'a substituted board must be visible on the row, not only in the audit');
});
