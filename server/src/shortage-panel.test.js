import { test } from 'node:test';
import assert from 'node:assert/strict';
import { panelMode } from '../../client/src/lib/shortagePanel.js';

// Which controls a requisition offers is no longer decided here — the PR register
// asks the same question, so it moved to client/src/lib/requisitionControls.js
// and is covered by requisition-controls.test.js. What is left is the one rule
// that really is the panel's own: which face it shows.

// ── panelMode ───────────────────────────────────────────────────────────────
// The old row rendered only while short > 0, so any action that resolved the
// shortage erased the result along with it. The panel now outlives the shortage.

test('a shortage shows the action card', () => {
  assert.equal(panelMode({ short: 28700, prs: [], lastMove: null }), 'card');
});

test('no shortage and nothing done renders nothing at all', () => {
  assert.equal(panelMode({ short: 0, prs: [], lastMove: null }), null);
});

test('a covered shortage with this job PR shows the PR strip', () => {
  assert.equal(panelMode({ short: 0, prs: [{ id: 1, status: 'pending' }], lastMove: null }), 'pr');
});

test('a completed move shows the move result', () => {
  assert.equal(panelMode({ short: 0, prs: [], lastMove: { qty: 500 } }), 'move');
});

test('a PR outranks a move when both happened — the PR is the one with controls', () => {
  assert.equal(panelMode({ short: 0, prs: [{ id: 1, status: 'pending' }], lastMove: { qty: 500 } }), 'pr');
});

test('a still-short line shows the card even after a partial move', () => {
  assert.equal(panelMode({ short: 200, prs: [{ id: 1, status: 'pending' }], lastMove: { qty: 500 } }), 'card');
});

test('a negative or missing short is not a shortage', () => {
  assert.equal(panelMode({ short: -5, prs: [], lastMove: null }), null);
  assert.equal(panelMode({ prs: [], lastMove: null }), null);
});

// panelMode guards its single object argument with a default `= {}`. Without it,
// calling it with no argument at all throws inside the destructure instead of
// answering "nothing to show" the way an empty object would — the same defensive
// shape as opening-counter.test.js's 'junk and missing arguments never produce a
// junk counter' test. prControls's half of this lives in
// requisition-controls.test.js, which makes the identical claim about it.
test('calling panelMode with no arguments at all does not throw', () => {
  assert.equal(panelMode(), null);
});
