import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineRequirement, rowCovers, mixBalance } from './board-mix.js';

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

test('client twin: identical rowCovers / mixBalance output across a spread of cases', () => {
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
