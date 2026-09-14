import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cutsOn, gateSubstitution, judge, parentsFor, rankOptions, sameGrade } from './xs-board-options.js';

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

// ── The empty rack — the case the whole picker exists for ──────────────────
//
// CI-XS-0013 on CI-JC-0295, live plant 2026-09-14: the planned board (FBB 290
// GSM 23×36, id 86) had ZERO on the shelf while 109 other boards did. The
// refusal is right — no sheets means no sheets — but blocked() used to hard-set
// planned:false, so the dialog's `options.find(o => o.planned)` came back
// undefined, no board was selected, and the whole Board panel (the warehouse
// button with it) rendered as an empty grey bar. The one approval that HAD to
// substitute was the one with no door to the shelf.
const EMPTY_PLANNED = B(86, 'FBB · 290 GSM · 23x36', 'FBB', 290, 23, 36, 0, 0);

test('a planned board with nothing on the shelf is refused but still reads as PLANNED', () => {
  const v = judge(EMPTY_PLANNED, { planned: EMPTY_PLANNED, product: PRODUCT, needed: 150, plannedCuts: 4 });
  assert.equal(v.blocked, true, 'no sheets is no sheets — physics, not a consequence');
  assert.match(v.block_reason, /Nothing on the shelf/);
  assert.equal(v.planned, true,
    'the picker finds the planned board by this flag alone — drop it and the panel renders blank');
});

test('the empty planned board still ranks first, so the approver reads WHY before the alternatives', () => {
  const opts = rankOptions([CROSS, LIGHTER, EMPTY_PLANNED, SMALLER].map(
    b => judge(b, { planned: EMPTY_PLANNED, product: PRODUCT, needed: 150, plannedCuts: 4 })), 150);
  assert.equal(opts[0].planned, true);
  assert.equal(opts[0].blocked, true);
  assert.ok(opts.slice(1).every(o => !o.blocked), 'every real alternative is still offered behind it');
});

test('a substitute is still judged on its own terms when the planned board is bare', () => {
  const v = judge(LIGHTER, { planned: EMPTY_PLANNED, product: PRODUCT, needed: 150, plannedCuts: 4 });
  assert.equal(v.planned, false);
  assert.equal(v.blocked, false);
  const g = gateSubstitution({
    candidate: LIGHTER, planned: EMPTY_PLANNED, product: PRODUCT, needed: 150, plannedCuts: 4,
    reason: 'planned board empty, press waiting',
  });
  assert.equal(g.ok, true, 'an empty planned board must not poison the boards that CAN run');
});

test('the dialog never hides the warehouse behind having a board', () => {
  // The button that opens the shelf used to live inside `approving.board && (…)`,
  // so a planned board that came back blocked took the door down with it.
  assert.match(page, /\{picker && picker !== 'loading' && \(/,
    'the shelf renders on the READ succeeding, not on a board being selected');
  assert.match(page, /\{!approving\.board && \(/, 'no board selected still offers Pick from warehouse');
  assert.match(page, /browsing: !planned \|\| !!planned\.blocked \|\| planned\.free < r\.qty/,
    'an empty rack opens the warehouse unprompted — it is the reason he is here');
  assert.match(page, /const boardBlocked/, 'a board that cannot be cut shows its reason, not a yield of zero');
  assert.match(page, /picker === null && \(/, 'a failed warehouse read offers a retry, never a blank panel');
});

// ── Board frozen for another product is not free board ─────────────────────
//
// Saving a plan writes a board_allocations hold with origin='plan_lock'. That
// hold is the plant's promise that those sheets belong to that product, and the
// XS picker's `free` must honour it — otherwise the approver is offered a whole
// frozen rack with no warning and no override to tick.
//
// COMMITTED_DEMAND_SQL reaches allocations only through order lines in
// ('planned','ready','in_production'). On the live plant 2026-09-14 two lines
// sat at 'pending' holding plan_lock freezes over their boards' ENTIRE stock —
// 454 of 454 sheets of Duplex WB 350 22×28, and 200 of 200 of Saffire 340
// 23×36 — and the picker reported both as fully free.
test('the XS shelf read fences plan-lock freezes committed demand cannot see', () => {
  assert.match(route, /frozen AS \(/, 'the freeze is a named CTE, not folded into committed demand');
  assert.match(route, /ba\.status = 'active' AND ba\.origin = 'plan_lock'/,
    "only live freezes — released and consumed holds have already left the shelf");
  assert.match(route, /ol\.status NOT IN \('planned','ready','in_production'\)/,
    'exactly the statuses committed demand has NOT charged, or the sheets are deducted twice');
  assert.match(route, /- COALESCE\(f\.qty, 0\), 0\) AS free/,
    'and it comes off free, so the default approval cannot touch frozen board');
});

// ── Best match first: closeness is MEASURED, not counted ───────────────────
//
// Anik, 2026-09-14: "you will show the best possible alternative matches first."
// Ranking used to break ties on "fewest cautions, then most stock", which made
// every same-grade board a near-tie the biggest pile won. The axes are now
// ordered by what they cost the plant, caliper first: a GSM change is not
// correctable, while a changed cut count is — the dialog hands back the parent
// count that buys the print sheets.
const LOWSTOCK  = { ...SMALLER, shelf: 120, free: 120 };   // same GSM, smaller sheet, cuts 4 → 2
const BIGPILE   = { ...LIGHTER, shelf: 9550, free: 9550 }; // same sheet and cuts, 54 GSM lighter

test('the same board in a smaller sheet beats a lighter one with eighty times the stock', () => {
  const opts = rankOptions([BIGPILE, LOWSTOCK].map(
    b => judge(b, { planned: PLANNED, product: PRODUCT, needed: 50, plannedCuts: 4 })), 50);
  assert.equal(opts[0].name, LOWSTOCK.name,
    'identical caliper makes an identical carton — the sheet size is a cutting-table problem');
  assert.equal(opts[0].same_gsm, true);
  assert.equal(opts[1].free, 9550, 'abundance still loses to closeness');
});

test('with the caliper equal, an unchanged cut count decides before trim', () => {
  const SAME_CUTS = B(801, 'Duplex WB · 350 GSM · 32x42', 'Duplex WB', 350, 32, 42, 400);
  const CUTS_MOVE = B(802, 'Duplex WB · 350 GSM · 25x36', 'Duplex WB', 350, 25, 36, 9000);
  const opts = rankOptions([CUTS_MOVE, SAME_CUTS].map(
    b => judge(b, { planned: PLANNED, product: PRODUCT, needed: 50, plannedCuts: 4 })), 50);
  assert.equal(opts[0].id, 801);
  assert.equal(opts[0].same_cuts, true, '4 up, exactly what was planned');
  assert.equal(opts[1].same_cuts, false);
});

test('a board that cannot cover the need still loses to one that can', () => {
  const PERFECT_BUT_EMPTY = { ...PLANNED, id: 803, name: 'Duplex WB · 350 GSM · 31.5x41.5 (rack B)', shelf: 10, free: 10 };
  const opts = rankOptions([PERFECT_BUT_EMPTY, BIGPILE].map(
    b => judge(b, { planned: PLANNED, product: PRODUCT, needed: 50, plannedCuts: 4 })), 50);
  assert.equal(opts[0].id, BIGPILE.id, 'ten sheets do not solve a fifty-sheet problem');
});

test('a figure that is not on file sorts last in its tier, never as a tie', () => {
  const NO_GSM = B(804, 'Duplex WB · unstated · 31.5x41.5', 'Duplex WB', null, 31.5, 41.5, 5000);
  const opts = rankOptions([NO_GSM, BIGPILE].map(
    b => judge(b, { planned: PLANNED, product: PRODUCT, needed: 50, plannedCuts: 4 })), 50);
  assert.equal(opts[0].id, BIGPILE.id, 'a known 54 GSM gap beats an unknown one');
});

// ── One grade only ────────────────────────────────────────────────────────
test('sameGrade is exported so the picker and the verdict cannot disagree', () => {
  assert.equal(sameGrade('FBB', ' fbb '), true);
  assert.equal(sameGrade('FBB', 'CFBB'), false, 'CFBB is its own grade, not a spelling of FBB');
  assert.equal(sameGrade('Saffire', 'Met Saffire'), false);
  assert.equal(sameGrade('FBB', null), false, 'an unstated grade is not a match for a known one');
});

test('the picker offers one grade, and says so instead of silently shrinking the shelf', () => {
  assert.match(route, /sameGrade\(m\.grade, planned\.grade\)/,
    'the offered set is filtered by the same grade test judge() uses');
  assert.match(route, /Number\(m\.id\) === Number\(planned\.id\)/,
    'the planned board is kept whatever its grade — it is the reason the list exists');
  assert.match(route, /const gradeRule = !!String\(planned\.grade \|\| ''\)\.trim\(\)/,
    'no rule can be applied when the planned board states no grade');
  assert.match(route, /grade_rule:/);
  assert.match(route, /other_grade_hidden:/, 'the count that was hidden goes on the wire');
  assert.match(page, /picker\.grade_rule &&/, 'and the panel prints the rule beside the shortened list');
  // The filter must NOT have become a refusal — the gate still judges whatever
  // board it is handed, or the ERP stops recording substitutions it cannot stop.
  assert.doesNotMatch(route, /blockers\.push\([^)]*grade/i);
});

// ── Searching the shelf exactly as the warehouse searches it ───────────────
test('the picker searches the BOARD, not the verdict written about it', () => {
  assert.match(page, /const boardIdentity = o => \(\{/);
  assert.match(page, /rowMatches\(boardIdentity\(o\), pickQ\)/,
    'the same matcher BoardPickerModal uses, over the same fields a material row carries');
  assert.doesNotMatch(page, /rowMatches\(o, pickQ/,
    'filtering the verdict put its own prose in the haystack — "Saffire is not FBB" matched FBB');
  assert.match(page, /placeholder="Board, grade, GSM, size, code…"/,
    "the warehouse's own placeholder, now that the code is actually searchable");
});

test('the floor code travels with the verdict — materials.code is on NO board, spec is on 354', () => {
  assert.match(route, /SELECT m\.id, m\.name, m\.code, m\.spec,/);
  const v = judge({ ...LIGHTER, spec: '3242296WB' },
    { planned: PLANNED, product: PRODUCT, needed: 50, plannedCuts: 4 });
  assert.equal(v.spec, '3242296WB');
  assert.equal(judge({ id: 9, category: 'tool', spec: 'X1' }, { planned: PLANNED, product: PRODUCT }).spec, 'X1',
    'a refused board keeps its code too, or a search for it returns nothing at all');
  assert.match(page, /\{opt\.spec &&/, 'and the row prints it, the way the warehouse table does');
});
