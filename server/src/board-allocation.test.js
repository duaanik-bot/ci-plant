import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boardPosition, lineNeed, openNeed, linePosition } from './board-allocation.js';

// A literal transcription of the formula running in production today
// (server/src/routes/orders.js, planning context). The property test below
// asserts the new engine agrees with it whenever nothing is allocated.
function legacyNet({ lineId, lines, available }) {
  const me = lines.find(l => l.id === lineId);
  const committedOther = lines
    .filter(l => l.id !== lineId)
    .reduce((s, l) => s + Number(l.parent_sheets_required ?? l.sheets_required ?? 0), 0);
  const need = Number(me.parent_sheets_required ?? me.sheets_required ?? 0);
  return available - committedOther - need;
}

const LINES = [
  { id: 1, parent_sheets_required: 41742 },
  { id: 2, parent_sheets_required: 20000 },
  { id: 3, parent_sheets_required: 6000 },
];

test('lineNeed: parent sheets win, child sheets are the fallback', () => {
  assert.equal(lineNeed({ parent_sheets_required: 500, sheets_required: 9000 }), 500);
  assert.equal(lineNeed({ parent_sheets_required: null, sheets_required: 9000 }), 9000);
  assert.equal(lineNeed({}), 0);
});

test('boardPosition: free is what is left after every active hold', () => {
  const p = boardPosition({
    available: 26000,
    allocations: [
      { order_line_id: 1, qty: 20000, source: 'stock', status: 'active' },
      { order_line_id: 2, qty: 5000, source: 'stock', status: 'released' },
      { order_line_id: 3, qty: 9000, source: 'requisition', status: 'active' },
    ],
  });
  assert.equal(p.available, 26000);
  assert.equal(p.held, 20000, 'released holds and incoming PRs must not count as held stock');
  assert.equal(p.free, 6000);
});

test('openNeed: what a job still has to find, after holds and incoming', () => {
  const line = { id: 1, parent_sheets_required: 41742 };
  const allocations = [
    { order_line_id: 1, qty: 20000, source: 'stock', status: 'active' },
    { order_line_id: 1, qty: 21742, source: 'requisition', status: 'active' },
  ];
  assert.equal(openNeed(line, allocations), 0);
  assert.equal(openNeed(line, []), 41742);
});

test('openNeed: never negative, even if over-held', () => {
  const line = { id: 1, parent_sheets_required: 1000 };
  const allocations = [{ order_line_id: 1, qty: 5000, source: 'stock', status: 'active' }];
  assert.equal(openNeed(line, allocations), 0);
});

// ── The property that makes this safe to ship ────────────────────────────────
test('PROPERTY: with no allocations, the new engine equals the old formula', () => {
  for (const available of [0, 1, 6000, 26000, 41742, 100000]) {
    for (const lineId of [1, 2, 3]) {
      const fresh = linePosition({ lineId, lines: LINES, available, allocations: [] });
      const old = legacyNet({ lineId, lines: LINES, available });
      assert.equal(fresh.net, old,
        `net disagreed for line ${lineId} at available=${available}`);
      assert.equal(fresh.short, Math.max(0, -old),
        `short disagreed for line ${lineId} at available=${available}`);
    }
  }
});

test('linePosition: a hold covers the holder and pushes everyone else short', () => {
  const allocations = [{ order_line_id: 1, qty: 20000, source: 'stock', status: 'active' }];
  const mine = linePosition({ lineId: 1, lines: LINES, available: 26000, allocations });
  assert.equal(mine.held_for_me, 20000);
  assert.equal(mine.my_open_need, 21742);

  const theirs = linePosition({ lineId: 2, lines: LINES, available: 26000, allocations });
  assert.equal(theirs.free, 6000, 'the held 20,000 is no longer free');
  assert.equal(theirs.held_for_me, 0);
  assert.equal(theirs.my_open_need, 20000);
});

test('linePosition: only planned/ready lines compete — callers pass the filtered set', () => {
  const p = linePosition({ lineId: 1, lines: [LINES[0]], available: 50000, allocations: [] });
  assert.equal(p.others_open_need, 0);
  assert.equal(p.short, 0);
});
