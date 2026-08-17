import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boardPositionView } from '../../client/src/lib/boardPositionView.js';

// THE SENTENCE the five tiles must read as:
//
//   In Warehouse − Committed = Free,  and  Free − This Plan = Net After Plan
//
// The strip claimed this in a comment for months while computing something
// else, and the plant paid for it on Saffire · 300 GSM · 23x36.

// The live world, 11 Aug 2026. 9,000 on the shelf; ACEBROBID (line 210, in
// production) has 8,959 frozen; HB-29 (line 295) plans 700 off the same board.
// ACEBROBID is fully held, so its OPEN need is 0 — which is exactly how its
// 8,959 disappeared from the Committed tile.
const HB29 = {
  available: 9000,
  committedOpen: 0,      // ACEBROBID has nothing left to find — it holds it all
  held: 8959,            // …but it holds 8,959
  heldForMe: 0,
  need: 700,
};

test('the strip adds up: In Warehouse − Committed = Free', () => {
  const p = boardPositionView(HB29);
  assert.equal(p.committed, 8959, 'a fully-frozen job is still committed board');
  assert.equal(p.free, 41);
  assert.equal(p.available - p.committed, p.free,
    'the row must read as a sentence — it showed 9,000 · 0 · 41, which does not');
});

test('the panel and the list agree: 700 wanted against 41 free is short 659', () => {
  const p = boardPositionView(HB29);
  assert.equal(p.net, -659, 'Net After Plan is free − this plan, not available − open need');
  assert.equal(p.short, 659,
    'the Planning list said Stock Short −659 from claimableQty; the panel said '
    + '"stock OK" and offered Lock Plan. This is the number they must both say.');
});

test('free − this plan = net after plan, for any world', () => {
  for (const w of [
    HB29,
    { available: 5000, committedOpen: 1000, held: 0, heldForMe: 0, need: 500 },
    { available: 5000, committedOpen: 0, held: 2000, heldForMe: 2000, need: 500 },
    { available: 5000, committedOpen: 800, held: 1200, heldForMe: 400, need: 5000 },
    { available: 100, committedOpen: 900, held: 0, heldForMe: 0, need: 50 },
  ]) {
    const p = boardPositionView(w);
    assert.equal(p.available - p.committed, p.free > 0 ? p.free : p.available - p.committed,
      'free is the clamped view of available − committed');
    assert.equal(p.net, (p.available - p.committed) - w.need,
      `net must be free − this plan for ${JSON.stringify(w)}`);
    // short is NOT −net. net is measured off the unclamped free so the tile can
    // show an over-committed board as over-committed; short is what this job
    // BUYS, and it is capped at its own requirement. The two only diverge once
    // other jobs have claimed more than the shelf holds — and there, −net is
    // their shortfall, not this plan's.
    assert.equal(p.short, Math.max(0, w.need - p.free));
    assert.ok(p.short <= w.need, `no job is short of more than it needs: ${JSON.stringify(w)}`);
  }
});

// OTHERS' HOLDS ARE NOT A SUBTRACTION. `held` from the server counts each
// line's hold CAPPED at that line's need (boardPosition); `held_for_me` is the
// raw uncapped SUM. Deriving others' holds as held − held_for_me therefore
// erases a rival's freeze by however much THIS line over-holds — and a line
// over-holds on the most ordinary path there is: parent_sheets_required is NULL
// until the first Save, so its capped contribution is 0 while Commit is already
// offered. This shipped for a day inside the very file written to end exactly
// this class of bug.
test('a rival\'s hold survives this line over-holding its own need', () => {
  // Shelf 9,000. A planned rival holds 3,000. This line is pending-unsaved
  // (need 0 as far as the server's cap is concerned) and has committed 700.
  const server = { available: 9000, committedOpen: 0, held: 3000, heldForMe: 700 };
  const wrong = boardPositionView({ ...server, need: 6500 });
  assert.equal(wrong.committed, 2300,
    'the OLD derivation: 3,000 − 700 loses 700 of the rival\'s claim');

  // The server sends its own others-only figure, capped-aware.
  const p = boardPositionView({ ...server, heldOthers: 3000, need: 6500 });
  assert.equal(p.committed, 3000, 'the rival holds 3,000 and still holds 3,000');
  assert.equal(p.free, 6000, 'and this job may draw 6,000 — the server\'s own linePosition.free');
  assert.equal(p.free_for_others, 5300,
    'unheld = 9,000 − 3,700, which is what the warehouse picker and the commit gate both compute');
  assert.equal(p.net, -500, 'a 6,500 plan against 6,000 free is 500 short');
  assert.equal(p.short, 500, 'and says so, instead of "stock OK" on a short plan');
});

test('held_others is used verbatim, never re-derived, and falls back safely', () => {
  const base = { available: 1000, committedOpen: 0, held: 400, heldForMe: 100, need: 0 };
  // Explicit wins even when it disagrees with the subtraction.
  assert.equal(boardPositionView({ ...base, heldOthers: 400 }).committed, 400);
  // Absent → the old subtraction, so an untaught caller is not broken.
  assert.equal(boardPositionView(base).committed, 300);
  // Zero is a real answer, not "absent".
  assert.equal(boardPositionView({ ...base, heldOthers: 0 }).committed, 0);
  assert.equal(boardPositionView({ ...base, heldOthers: -5 }).committed, 0, 'never negative');
});

test('a job is never committed against itself', () => {
  // Its own freeze is the reason the sheets are waiting for it.
  const p = boardPositionView({ available: 9000, committedOpen: 0, held: 8959, heldForMe: 8959, need: 700 });
  assert.equal(p.committed, 0);
  assert.equal(p.free, 9000);
  assert.equal(p.short, 0, 'it may draw its own hold plus what is free');
});

test('an over-committed board keeps its sign instead of flooring at zero', () => {
  const p = boardPositionView({ available: 100, committedOpen: 0, held: 900, heldForMe: 0, need: 50 });
  assert.equal(p.free, 0, 'the tile never shows negative free');
  assert.equal(p.net, -850, 'but net still carries the whole hole: 100 − 900 − 50');
  // …and the hole is not this job's to buy. 800 of it is other jobs holding
  // board that is not on the shelf; they answer for that. This plan needs 50,
  // has nothing free to it, and buys 50.
  assert.equal(p.short, 50, 'it buys its own 50, not the 850-sheet hole');
});

// ACEBROBID's own view. It chose "Fresh PR — leave stock free", so the shelf is
// not what it is SHORT of — that verdict must not move.
test('a fresh-PR plan is not short of a shelf it refuses, and its row adds up', () => {
  const p = boardPositionView({
    available: 9000, committedOpen: 659, held: 9000, heldForMe: 8959,
    need: 8959, fresh: true, planParent: 8959, ownIncoming: 0,
  });
  assert.equal(p.committed, 700, "HB-29's 659 still to find plus the 41 it froze");
  assert.equal(p.free, 8300, 'unchanged — this is what the panel already showed');
  assert.equal(p.available - p.committed, p.free, 'and 9,000 = 700 + 8,300 now holds (it read 659 + 8,300)');
  assert.equal(p.short, 0, 'covered by its own hold — "covered · shelf left free"');
  // Net is a DIFFERENT question from short: what this pile reads once this job
  // has cut. It takes its own 8,959 off a shelf with 8,300 free of others'
  // claims, so the others end up 659 short — which is exactly true: the pile
  // will hold 41 and they are owed 700.
  assert.equal(p.net, -659, 'net after plan is honest about what it leaves behind');
});

// THE FRESH-PR LIFECYCLE. "This plan buys its board fresh, so it leaves the
// shelf alone" is true only while the board is ON ORDER. A landed, covered PR
// BECOMES a hold on this very shelf, and drawing it takes the pile down.
// ACEBROBID: 9,000 on the shelf, 8,959 of it its own delivered board — the
// tile read Net After Plan 9,000 for a pile that will read 41.
test('a fresh-PR plan leaves the shelf alone until its board LANDS', () => {
  const world = extra => boardPositionView({
    available: 9000, committedOpen: 0, fresh: true, planParent: 8959, ...extra });

  // Nothing landed: the shelf is untouched by this plan, as before.
  assert.equal(world({ held: 0, heldForMe: 0, ownIncoming: 8959 }).net, 9000);

  // Landed and frozen for this job: it draws its own hold off this pile.
  const landed = world({ held: 8959, heldForMe: 8959, ownIncoming: 0 });
  assert.equal(landed.net, 41, 'the number the warehouse register reads: 0.41 of a packet');
  assert.equal(landed.net, landed.free_for_others,
    'with no rival claims, what it leaves IS what nobody holds');

  // Half landed: only the part on the shelf comes off it.
  assert.equal(boardPositionView({
    available: 4000, committedOpen: 0, held: 4000, heldForMe: 4000,
    fresh: true, planParent: 8959, ownIncoming: 4959 }).net, 0);

  // A hold larger than the plan cannot take more than the plan will cut.
  assert.equal(world({ held: 9000, heldForMe: 9000, ownIncoming: 0 }).net, 9000 - 8959);
});

// "Free" has a viewer. position.free is THIS job's view — its own freeze sits
// inside it, because a job is never committed against itself. What OTHER
// products may promise themselves is free_for_others = free − own hold. The
// fresh-PR caption printed position.free as "free for other products": 9,000
// on a shelf where 8,959 was this very job's hold and the true answer was 41 —
// four-tenths of one packet of over-delivery, presented as nine thousand
// sheets of plenty.
test('free_for_others: a job\'s own freeze is not on offer to the plant', () => {
  // ACEBROBID's view of board 3: everything held is its own.
  const p = boardPositionView({
    available: 9000, committedOpen: 0, held: 8959, heldForMe: 8959,
    need: 8959, fresh: true, planParent: 8959,
  });
  assert.equal(p.free, 9000, 'its OWN free is the whole shelf — never committed against itself');
  assert.equal(p.free_for_others, 41,
    'but only the over-delivery is free for anyone else: 9,000 − 8,959');
  // And the two views agree with HB-29 reading the same shelf from outside:
  const other = boardPositionView({ available: 9000, committedOpen: 0, held: 8959, heldForMe: 0, need: 700 });
  assert.equal(other.free, p.free_for_others,
    'what this job calls free-for-others IS what the next job calls free');
});

test('free_for_others never exceeds free, and both floor at zero', () => {
  for (const w of [
    { available: 9000, committedOpen: 0, held: 8959, heldForMe: 8959, need: 0 },
    { available: 100, committedOpen: 900, held: 50, heldForMe: 50, need: 0 },
    { available: 5000, committedOpen: 800, held: 1200, heldForMe: 400, need: 100 },
    { available: 0, committedOpen: 0, held: 0, heldForMe: 0, need: 0 },
  ]) {
    const p = boardPositionView(w);
    assert.ok(p.free_for_others <= p.free, JSON.stringify(w));
    assert.ok(p.free_for_others >= 0);
  }
});

// The caption itself is pinned: the sentence "…stay free for other products"
// must render free_for_others. It rendered position.free for months, and no
// arithmetic test can catch a correct number bound to the wrong sentence.
test('the fresh-PR caption says free_for_others, never free', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../../client/src/pages/Planning.jsx', import.meta.url), 'utf8');
  const i = src.indexOf('available to other products');
  assert.ok(i > 0, 'the caption still exists');
  const around = src.slice(i - 500, i);
  assert.match(around, /position\.free_for_others/,
    'the number in the other-products sentence is free_for_others');
  assert.doesNotMatch(around, /fmt\.num\(position\.free\)/,
    'position.free is this job\'s own view and must not be captioned as other products\' stock');
});

// A correct number under a borrowed word is still a wrong card. The caption was
// fixed to 41 and then sat four lines under a tile shouting FREE 9,000 — both
// right for their own viewer, neither saying which. One card may not print two
// different numbers under one word.
test('the card spends the word "free" on exactly one quantity', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../../client/src/pages/Planning.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /free sheets stay free for other/,
    'the other-products sentence must not reuse the Free tile\'s word');
  assert.match(src, /sheets nobody holds stay\s*\n?\s*available to other products/,
    'it says UNHELD and leaves "free" to the tile');
  // The RENDERED literal, not any mention: the comment above it quotes the old
  // wording on purpose, and a blunt grep would forbid explaining the bug.
  assert.doesNotMatch(src, /'Parent sheets · this plan buys its board fresh — free stock stays with other jobs'/,
    'the fresh-mode footnote borrowed the same word for the same wrong viewer');
  assert.match(src, /the stock nobody holds stays with other jobs'/,
    '…and now names the viewer like its non-fresh twin');
  // …and the tile decomposes itself whenever the job holds any of the shelf,
  // so the two halves are visible without reading the sentence below.
  assert.match(src, /hint=\{\(\+ctx\.stock\.held_for_me \|\| 0\) > 0/,
    'the Free tile carries a hint when this job holds stock');
  assert.match(src, /yours · \$\{fmt\.num\(position\.free_for_others\)\} unheld/,
    'and the hint splits it into yours vs unheld');
});

test('once cutting has drawn the board nothing is outstanding', () => {
  const p = boardPositionView({ available: 41, committedOpen: 0, held: 0, heldForMe: 0, need: 0, drawn: true });
  assert.equal(p.short, 0);
  const f = boardPositionView({ available: 41, committedOpen: 0, held: 0, heldForMe: 0,
    need: 0, fresh: true, drawn: true, planParent: 8959 });
  assert.equal(f.short, 0, 'a drawn fresh-PR plan has nothing left to buy either');
});

// ── A job may never be asked to buy another job's shortfall ─────────────────
//
// GLYCOMET, 17 Aug 2026. Saffire · 290 GSM · 26x30, nothing on the shelf.
// Line 487 wants 2,475 parent sheets and CI-PR-0066 is already buying them —
// but that PR wrote no incoming row (it was raised seconds before the plan that
// moved the job onto this board), so line 487 still reads as 2,475 unbought.
//
// Line 490 is then planned for 2,038 of the same board and the engine offered
// 4,513 = 2,038 + 2,475. The buyer took it, and CI-VPO-0035 went out carrying
// line 487's board TWICE.
//
// `net` is right to go negative — the board really is over-committed and the
// tile must say so. `short` is a different question: it is what THIS job puts
// on a purchase order, and no job can be short of more than it needs.
test('short never exceeds this job\'s own requirement, however over-committed the board', () => {
  const p = boardPositionView({
    available: 0,
    committedOpen: 2475,   // line 487's open need — its PR is invisible
    held: 0, heldForMe: 0,
    need: 2038,            // line 490's own cut plan
  });
  assert.equal(p.short, 2038, 'this job buys ITS 2,038 — the other job raises its own PR');
  assert.equal(p.net, -4513, 'the NET tile still tells the truth about the board');
  assert.equal(p.committed, 2475);
  assert.equal(p.free, 0);
});

// Three jobs, 5,000 each, empty shelf — the shape Anik reported. Whatever order
// they are planned in, and even with every sibling PR invisible, the three
// requisitions can only ever add up to what the three jobs need.
test('three equal jobs on a bare shelf ask for their own need, never the pile', () => {
  const need = 5000;
  const asks = [10000, 5000, 0].map(committedOpen =>
    boardPositionView({ available: 0, committedOpen, held: 0, heldForMe: 0, need }).short);
  assert.deepEqual(asks, [5000, 5000, 5000]);
  assert.equal(asks.reduce((a, b) => a + b), 15000, 'three 5,000 jobs buy 15,000 — not 30,000');
});

// The clamp must not touch the ordinary contested shelf: stock that is genuinely
// spoken for by someone else is not available to this job, and it still buys the
// difference. Only the part that is other jobs' UNMET need falls away.
test('a contested but not over-committed shelf still charges this job the difference', () => {
  const p = boardPositionView({ available: 8000, committedOpen: 5000, held: 0, heldForMe: 0, need: 5000 });
  assert.equal(p.free, 3000);
  assert.equal(p.short, 2000, '5,000 needed, 3,000 genuinely free to it');
});
