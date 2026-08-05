import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BOARD_RANK, worstBoardStateOf, rowBoardStateOf } from '../../client/src/lib/boardState.js';

// Collapsing a grouped queue row to ONE board verdict.
//
// A gang prints as one sheet, so its weakest member decides for the whole run.
// Planning and Artwork both group gangs CLIENT-side (the server cannot have
// collapsed a row it never grouped), so both need this, and both had it:
// Artwork called the shared `worstBoardStateOf`, Planning hand-rolled the same
// `.map().reduce()` over BOARD_RANK a second time.
//
// The copies were not identical, and the difference is deliberate — which is
// exactly why it had to become a PARAMETER rather than a reason to keep two
// readers. A member with no `board_state` (an older payload served mid-deploy)
// reads:
//   Artwork    'covered' — this queue has no other signal, and a stale response
//              must not paint the whole page red.
//   Planning   its own board gate, because a Planning row carries `readiness`.
//              Defaulting to covered there would hide a genuinely short job on
//              the one screen whose job is to fix it.
//
// This lives in lib/ rather than components/BoardStatus.jsx because that file
// holds JSX and cannot be imported by a node test — so the rule that decides
// what the plant sees had never been executed by a test at all, only grepped.
// BoardStatus.jsx re-exports these, so every existing import site is unchanged.

const m = (board_state, readiness) => ({ board_state, readiness });

test('the rank orders the vocabulary worst-first', () => {
  assert.ok(BOARD_RANK.short < BOARD_RANK.on_order, 'short is worse than on_order');
  assert.ok(BOARD_RANK.on_order < BOARD_RANK.covered, 'on_order is worse than covered');
});

// ── the collapse ──────────────────────────────────────────────────────
test('the weakest member decides for the whole run', () => {
  assert.equal(worstBoardStateOf([m('covered'), m('short'), m('on_order')]), 'short');
  assert.equal(worstBoardStateOf([m('covered'), m('on_order')]), 'on_order');
  assert.equal(worstBoardStateOf([m('covered'), m('covered')]), 'covered');
});

test('a member with no verdict reads covered by default', () => {
  assert.equal(worstBoardStateOf([m(null), m('covered')]), 'covered',
    'a stale payload must not paint the queue red');
  assert.equal(worstBoardStateOf([]), 'covered');
  assert.equal(worstBoardStateOf(null), 'covered');
});

// The regression that lets the two pages share one reader.
test('a fallback decides only what a member with NO verdict reads', () => {
  const gate = x => (x.readiness?.material ? 'covered' : 'short');
  assert.equal(worstBoardStateOf([m(null, { material: false })], gate), 'short',
    "Planning's own fallback: no verdict, and its board gate is not met");
  assert.equal(worstBoardStateOf([m(null, { material: true })], gate), 'covered',
    'no verdict, but the board gate says the board is there');
  assert.equal(worstBoardStateOf([m(null)], gate), 'short', 'no readiness at all reads short');
  assert.equal(worstBoardStateOf([m('on_order', { material: false })], gate), 'on_order',
    'a member that HAS a verdict must ignore the fallback entirely');
});

test('the fallback cannot make a run read better than its worst member', () => {
  const gate = () => 'covered';
  assert.equal(worstBoardStateOf([m(null), m('short')], gate), 'short');
});

// ── the grouped row ───────────────────────────────────────────────────
test('a grouped row collapses its members, a plain row is its own verdict', () => {
  assert.equal(rowBoardStateOf({ board_state: 'on_order' }), 'on_order');
  assert.equal(rowBoardStateOf({ _gang: [m('covered'), m('short')] }), 'short',
    'the run is judged on its members, not on the synthetic row wrapping them');
});

test('a grouped row passes the fallback down to each member', () => {
  const gate = x => (x.readiness?.material ? 'covered' : 'short');
  assert.equal(rowBoardStateOf({ _gang: [m(null, { material: true }), m(null, { material: true })] }, gate),
    'covered');
  assert.equal(rowBoardStateOf({ _gang: [m(null, { material: true }), m(null, { material: false })] }, gate),
    'short', 'one member short of board stops the whole run');
});

test('an absent row does not throw', () => {
  assert.equal(rowBoardStateOf(null), 'covered');
  assert.equal(rowBoardStateOf(undefined), 'covered');
});

// An empty `_gang` must not read as the row itself — a grouped row with no
// members is a bug upstream, and answering 'covered' says "nothing to worry
// about" rather than inventing a verdict from the synthetic wrapper.
test('an empty group reads covered, never the wrapper row', () => {
  assert.equal(rowBoardStateOf({ _gang: [], board_state: 'short' }), 'covered');
});

// ── equivalence with what Planning used to compute ────────────────────
// Folding Planning onto the shared reader is only safe if it answers the same
// thing. Its old body, verbatim, versus the new call — over every combination
// of the states and readiness values a member can actually hold, for runs of
// one to three members. A screen-by-screen eyeball cannot cover this; the state
// space is small enough to cover exhaustively, so it is.
test('the shared reader reproduces Planning\'s old collapse exactly', () => {
  const BOARD_RANK_OLD = { short: 0, on_order: 1, covered: 2 };
  const oldStateOf = r => (r._gang || [r])
    .map(m => m.board_state || (m.readiness?.material ? 'covered' : 'short'))
    .reduce((worst, s) => (BOARD_RANK_OLD[s] < BOARD_RANK_OLD[worst] ? s : worst), 'covered');

  const gate = x => (x.readiness?.material ? 'covered' : 'short');
  const newStateOf = r => rowBoardStateOf(r, gate);

  // Everything a member can be: each board_state (plus absent), crossed with
  // each shape of readiness the fallback looks at.
  const members = [];
  for (const board_state of ['covered', 'on_order', 'short', null, undefined])
    for (const readiness of [{ material: true }, { material: false }, {}, undefined])
      members.push({ board_state, readiness });

  let checked = 0;
  for (const a of members) {
    assert.equal(newStateOf(a), oldStateOf(a), `ungrouped ${JSON.stringify(a)}`);
    checked++;
    for (const b of members) {
      for (const group of [[a, b], [a, b, a]]) {
        const row = { _gang: group };
        assert.equal(newStateOf(row), oldStateOf(row), `grouped ${JSON.stringify(group)}`);
        checked++;
      }
    }
  }
  assert.ok(checked > 800, `expected the full cross-product, checked ${checked}`);
});
