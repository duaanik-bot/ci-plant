import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openingCounter } from '../../client/src/lib/received.js';

// ── the bug this rule exists to kill ──────────────────────────────────
// CI-GANG-JC-0038, cutting. 1,383 parents issued, 2 cuts each — 2,766 print
// sheets expected. Ankit counted all 2,766 in one day count. Opening "Count /
// Finish" then showed an EMPTY counter box and a dead Complete Stage button:
// the stage knew it held 2,766 of 2,766 and still asked the operator to key
// the same figure a second time. Every partially-counted row was blanked on
// open, whether or not anything was left to count.
test('a stage counted to its full issue opens ready to close, not blank', () => {
  assert.equal(openingCounter({ expected: 2766, priorGood: 2766, hasRuns: true }), '2766');
});

test('the same rule on the gang figures from the report — 8,480 of 8,480', () => {
  assert.equal(openingCounter({ expected: 8480, priorGood: 8480, hasRuns: true }), '8480');
});

// ── what must NOT change ──────────────────────────────────────────────
// A running row has always opened on the full expected output: the common
// close is one click, and that is the behaviour operators already have.
test('a stage with nothing counted yet still opens on the full expected output', () => {
  assert.equal(openingCounter({ expected: 8480, priorGood: 0, hasRuns: false }), '8480');
});

// A part-counted stage must stay blank. The counter reads whatever it reads;
// pre-filling a guess there is how a wrong figure gets confirmed by reflex.
test('a part-counted stage still opens blank — the operator reads the machine', () => {
  assert.equal(openingCounter({ expected: 8480, priorGood: 4000, hasRuns: true }), '');
  assert.equal(openingCounter({ expected: 8480, priorGood: 8479, hasRuns: true }), '');
});

// A run that recorded only wastage leaves nothing good on the log. The stage
// is "partially completed" but nothing has been counted, so the box stays
// blank exactly as before.
test('a scrap-only run leaves the box blank — nothing good has been counted', () => {
  assert.equal(openingCounter({ expected: 8480, priorGood: 0, hasRuns: true }), '');
});

// An over-run opens on what was actually counted, never on the plan. The
// cutting variance gate then asks for a reason, which is the right question.
test('an over-counted stage opens on the counted figure, not the planned one', () => {
  assert.equal(openingCounter({ expected: 8480, priorGood: 8500, hasRuns: true }), '8500');
});

// No expected figure means nothing to measure against — never invent one.
test('a stage with no expected output opens blank whatever the log holds', () => {
  assert.equal(openingCounter({ expected: 0, priorGood: 0, hasRuns: false }), '');
  assert.equal(openingCounter({ expected: 0, priorGood: 500, hasRuns: true }), '');
});

test('junk and missing arguments never produce a junk counter', () => {
  assert.equal(openingCounter({}), '');
  assert.equal(openingCounter(), '');
  assert.equal(openingCounter({ expected: -5, priorGood: -5, hasRuns: true }), '');
});
