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
    assert.equal(p.short, Math.max(0, -p.net));
  }
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
  assert.equal(p.short, 850);
});

// ACEBROBID's own view. It chose "Fresh PR — leave stock free", so the shelf is
// not what it is short of — and its verdict must not move.
test('a fresh-PR plan reads exactly as it did, and its row also adds up', () => {
  const p = boardPositionView({
    available: 9000, committedOpen: 659, held: 9000, heldForMe: 8959,
    need: 8959, fresh: true, planParent: 8959, ownIncoming: 0,
  });
  assert.equal(p.committed, 700, "HB-29's 659 still to find plus the 41 it froze");
  assert.equal(p.free, 8300, 'unchanged — this is what the panel already showed');
  assert.equal(p.net, 8300, 'unchanged');
  assert.equal(p.available - p.committed, p.free, 'and 9,000 = 700 + 8,300 now holds (it read 659 + 8,300)');
  assert.equal(p.short, 0, 'covered by its own hold — "covered · shelf left free"');
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
