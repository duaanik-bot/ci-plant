import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineRequirement, rowCovers, mixBalance, substitutionFlags } from './board-mix.js';

test('lineRequirement: parent sheets win, child sheets are the fallback', () => {
  assert.equal(lineRequirement({ parent_sheets_required: 500, sheets_required: 9000 }), 500);
  assert.equal(lineRequirement({ parent_sheets_required: null, sheets_required: 9000 }), 9000);
  assert.equal(lineRequirement({}), 0);
});

test('a same-ups row covers its own sheet count', () => {
  assert.equal(rowCovers({ sheets: 1500, ups: 6, plannedUps: 6 }), 1500);
});

test('a higher-ups row covers more than its sheet count', () => {
  assert.equal(rowCovers({ sheets: 1500, ups: 8, plannedUps: 6 }), 2000);
});

test('a lower-ups row covers less than its sheet count', () => {
  assert.equal(rowCovers({ sheets: 1200, ups: 4, plannedUps: 6 }), 800);
});

test('plannedUps of zero throws rather than dividing', () => {
  assert.throws(() => rowCovers({ sheets: 100, ups: 6, plannedUps: 0 }), /plannedUps/);
});

test('row ups of zero throws — a board that fits nothing covers nothing', () => {
  assert.throws(() => rowCovers({ sheets: 100, ups: 0, plannedUps: 6 }), /ups/);
});

// A prior review caught these messages interpolating the COERCED value: a
// typo'd plannedUps of 'abc' reported "got NaN", which names no culprit. The
// raw input is what a planner or an upstream row can actually be traced from.
test('a bad plannedUps or ups names the actual value in the error, not the coerced NaN', () => {
  assert.throws(() => rowCovers({ sheets: 100, ups: 6, plannedUps: 'abc' }), /abc/);
  assert.throws(() => rowCovers({ sheets: 100, ups: 'xyz', plannedUps: 6 }), /xyz/);
});

test('a two-board mix that sums to the requirement is balanced', () => {
  const rows = [{ covers: 2500 }, { covers: 1500 }];
  const b = mixBalance({ required: 4000, rows });
  assert.equal(b.active, true);
  assert.equal(b.required, 4000);
  assert.equal(b.covered, 4000);
  assert.equal(b.balance, 0);
  assert.equal(b.balanced, true);
});

test('an under-allocated mix reports the remaining balance', () => {
  const b = mixBalance({ required: 4000, rows: [{ covers: 2500 }] });
  assert.equal(b.balance, 1500);
  assert.equal(b.balanced, false);
});

test('an over-allocated mix reports a negative balance and is not balanced', () => {
  const b = mixBalance({ required: 4000, rows: [{ covers: 2500 }, { covers: 2000 }] });
  assert.equal(b.balance, -500);
  assert.equal(b.balanced, false);
});

// These are DOUBLE PRECISION columns. `covered === required` is the trap that
// already caught the replenishment code — 0.1+0.2 style drift must still read
// as balanced.
test('float drift under EPS still counts as balanced', () => {
  const rows = [{ covers: 0.1 }, { covers: 0.2 }];
  const b = mixBalance({ required: 0.3, rows });
  assert.notEqual(b.covered, 0.3, 'precondition: this sum really is inexact');
  assert.equal(b.balanced, true);
});

test('no rows means the mix is not in play at all', () => {
  const b = mixBalance({ required: 4000, rows: [] });
  assert.equal(b.active, false);
  assert.equal(b.balanced, false);
});

test('a line composes into mixBalance through lineRequirement', () => {
  const line = { sheets_required: 900 };
  const b = mixBalance({ required: lineRequirement(line), rows: [{ covers: 900 }] });
  assert.equal(b.required, 900);
  assert.equal(b.balanced, true);
});

// ── the substitution rule ─────────────────────────────────────────────
// Grade is the customer's specification and never changes; GSM and sheet size
// are the plant's problem, and childFit's ups decide how expensive they are.
const SAFFIRE_300 = { id: 1, name: 'Saffire · 300 GSM · 23x36' };
const SAFFIRE_290 = { id: 2, name: 'Saffire · 290 GSM · 23x36' };
const SAFFIRE_300_BIG = { id: 3, name: 'Saffire · 300 GSM · 25x36' };
const DUPLEX_300 = { id: 4, name: 'Duplex GB · 300 GSM · 23x36' };

test('the planned board itself carries no flag', () => {
  const f = substitutionFlags({
    plannedBoard: SAFFIRE_300, candidateBoard: SAFFIRE_300, plannedUps: 6, candidateUps: 6 });
  assert.equal(f.ok, true);
  assert.equal(f.severity, 'none');
  assert.equal(f.reason_required, false);
});

test('a different grade is blocked, never merely warned', () => {
  const f = substitutionFlags({
    plannedBoard: SAFFIRE_300, candidateBoard: DUPLEX_300, plannedUps: 6, candidateUps: 6 });
  assert.equal(f.ok, false);
  assert.equal(f.grade_ok, false);
  assert.equal(f.severity, 'blocked');
});

test('a GSM change on the same size warns and needs a reason', () => {
  const f = substitutionFlags({
    plannedBoard: SAFFIRE_300, candidateBoard: SAFFIRE_290, plannedUps: 6, candidateUps: 6 });
  assert.equal(f.ok, true);
  assert.equal(f.gsm_delta, -10);
  assert.equal(f.size_differs, false);
  assert.equal(f.ups_differ, false);
  assert.equal(f.severity, 'warn');
  assert.equal(f.reason_required, true);
});

test('a bigger sheet that still cuts the same ups is only extra trim', () => {
  const f = substitutionFlags({
    plannedBoard: SAFFIRE_300, candidateBoard: SAFFIRE_300_BIG, plannedUps: 6, candidateUps: 6 });
  assert.equal(f.ok, true);
  assert.equal(f.size_differs, true);
  assert.equal(f.ups_differ, false);
  assert.equal(f.severity, 'warn');
});

test('a sheet that changes the ups is heavy — it needs its own plate layout', () => {
  const f = substitutionFlags({
    plannedBoard: SAFFIRE_300, candidateBoard: SAFFIRE_300_BIG, plannedUps: 6, candidateUps: 8 });
  assert.equal(f.ups_differ, true);
  assert.equal(f.severity, 'heavy');
  assert.equal(f.ok, true, 'the maths supports it even where this build gates the UI');
});

// A prior review caught these three as false "warn"/"heavy" passes. num()
// maps a missing argument to 0, so a caller that forgot the cut plan got
// "fine, just warn" instead of a refusal — and a candidate childFit reports
// as count: 0 (helpers.js:104, a board sized but unable to fit the child at
// all) read as ups_differ: true, i.e. merely 'heavy', so it survived the
// Task 7 candidate filter and reached the planner's dropdown as a row that
// would only be refused later, on save.
test('a candidate that cannot fit the child at all is blocked, not "heavy"', () => {
  const f = substitutionFlags({
    plannedBoard: SAFFIRE_300, candidateBoard: SAFFIRE_300_BIG, plannedUps: 6, candidateUps: 0 });
  assert.equal(f.ok, false);
  assert.equal(f.severity, 'blocked');
});

test('a planned board with no recorded ups blocks rather than reading as a match', () => {
  const f = substitutionFlags({
    plannedBoard: SAFFIRE_300, candidateBoard: SAFFIRE_300_BIG, plannedUps: 0, candidateUps: 6 });
  assert.equal(f.ok, false);
  assert.equal(f.severity, 'blocked');
});

test('omitted ups entirely blocks — a caller that asked nothing gets no "fine, just warn"', () => {
  const f = substitutionFlags({ plannedBoard: SAFFIRE_300, candidateBoard: SAFFIRE_300_BIG });
  assert.equal(f.ok, false);
  assert.equal(f.severity, 'blocked');
});

test('an unparseable board name blocks rather than guessing at its grade', () => {
  const f = substitutionFlags({
    plannedBoard: SAFFIRE_300, candidateBoard: { id: 9, name: 'mystery board' },
    plannedUps: 6, candidateUps: 6 });
  assert.equal(f.ok, false);
  assert.equal(f.severity, 'blocked');
});

test('grade matching ignores case and padding', () => {
  const f = substitutionFlags({
    plannedBoard: { id: 1, name: 'saffire · 300 GSM · 23x36' },
    candidateBoard: SAFFIRE_290, plannedUps: 6, candidateUps: 6 });
  assert.equal(f.grade_ok, true);
});

// ── client twin parity ────────────────────────────────────────────────
// A later task adds a React panel that must show the same balance the release
// gate computes. The server sums the STORED `covers` column — stored rather
// than derived so the balance a planner saw is the balance that gets audited
// (see the design doc) — and a hand-rolled panel that recomputed `covers` from
// live `ups` instead could show a green zero balance while the gate stayed
// shut. Same precedent as the boardMath twin parity block in board-math.test.js.
import * as client from '../../client/src/lib/boardMix.js';
import * as server from './board-mix.js';

test('client twin: exported surface matches the server module', () => {
  assert.deepEqual(Object.keys(client).sort(), Object.keys(server).sort());
});

test('client twin: identical lineRequirement / rowCovers / mixBalance output across a spread of cases', () => {
  // lineRequirement's whole justification is a lockstep concern — a reviewer
  // proved this exact gap by flipping the client copy's precedence to
  // `sheets_required ?? parent_sheets_required` and all tests still passed.
  // Both precedence directions must be exercised WITH BOTH FIELDS PRESENT AND
  // DIFFERING: a case where only one field is set can't tell the two
  // orderings apart, since either order falls back to the same lone value.
  const lineRequirementCases = [
    { parent_sheets_required: 500, sheets_required: 9000 }, // parent wins over a differing child count
    { parent_sheets_required: null, sheets_required: 9000 }, // absent parent falls back to child
    {}, // neither present
  ];
  for (const c of lineRequirementCases) {
    assert.equal(client.lineRequirement(c), server.lineRequirement(c));
  }

  const rowCases = [
    { sheets: 1500, ups: 6, plannedUps: 6 },
    { sheets: 1500, ups: 8, plannedUps: 6 },
    { sheets: 1200, ups: 4, plannedUps: 6 },
  ];
  for (const c of rowCases) {
    assert.equal(client.rowCovers(c), server.rowCovers(c));
  }

  const balanceCases = [
    { required: 4000, rows: [{ covers: 2500 }, { covers: 1500 }] },
    { required: 4000, rows: [{ covers: 2500 }] },
    { required: 4000, rows: [{ covers: 2500 }, { covers: 2000 }] },
    { required: 0.3, rows: [{ covers: 0.1 }, { covers: 0.2 }] }, // float drift
    { required: 4000, rows: [] },
  ];
  for (const c of balanceCases) {
    assert.deepEqual(client.mixBalance(c), server.mixBalance(c));
  }
});

test('client twin: both throw guards raise identically', () => {
  assert.throws(() => client.rowCovers({ sheets: 100, ups: 6, plannedUps: 0 }), /plannedUps/);
  assert.throws(() => client.rowCovers({ sheets: 100, ups: 0, plannedUps: 6 }), /ups/);
});

test('client twin: identical substitutionFlags output across a spread of boards, including the blocked cases', () => {
  const cases = [
    { plannedBoard: SAFFIRE_300, candidateBoard: SAFFIRE_300, plannedUps: 6, candidateUps: 6 }, // itself
    { plannedBoard: SAFFIRE_300, candidateBoard: DUPLEX_300, plannedUps: 6, candidateUps: 6 }, // blocked: grade
    { plannedBoard: SAFFIRE_300, candidateBoard: SAFFIRE_290, plannedUps: 6, candidateUps: 6 }, // warn: GSM
    { plannedBoard: SAFFIRE_300, candidateBoard: SAFFIRE_300_BIG, plannedUps: 6, candidateUps: 6 }, // warn: size, same ups
    { plannedBoard: SAFFIRE_300, candidateBoard: SAFFIRE_300_BIG, plannedUps: 6, candidateUps: 8 }, // heavy: ups differ
    { plannedBoard: SAFFIRE_300, candidateBoard: { id: 9, name: 'mystery board' }, plannedUps: 6, candidateUps: 6 }, // blocked: unparseable
    { plannedBoard: { id: 1, name: 'saffire · 300 GSM · 23x36' }, candidateBoard: SAFFIRE_290, plannedUps: 6, candidateUps: 6 }, // case/padding
    { plannedBoard: SAFFIRE_300, candidateBoard: SAFFIRE_300_BIG, plannedUps: 6, candidateUps: 0 }, // blocked: candidate can't fit at all
    { plannedBoard: SAFFIRE_300, candidateBoard: SAFFIRE_300_BIG, plannedUps: 0, candidateUps: 6 }, // blocked: no planned ups
    { plannedBoard: SAFFIRE_300, candidateBoard: SAFFIRE_300_BIG }, // blocked: ups omitted entirely
  ];
  for (const c of cases) {
    assert.deepEqual(client.substitutionFlags(c), server.substitutionFlags(c));
  }
});
