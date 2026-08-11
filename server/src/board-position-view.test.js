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

test('once cutting has drawn the board nothing is outstanding', () => {
  const p = boardPositionView({ available: 41, committedOpen: 0, held: 0, heldForMe: 0, need: 0, drawn: true });
  assert.equal(p.short, 0);
  const f = boardPositionView({ available: 41, committedOpen: 0, held: 0, heldForMe: 0,
    need: 0, fresh: true, drawn: true, planParent: 8959 });
  assert.equal(f.short, 0, 'a drawn fresh-PR plan has nothing left to buy either');
});
