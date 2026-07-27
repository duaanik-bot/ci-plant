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
    for (const me of LINES) {
      const others = LINES.filter(l => l.id !== me.id);
      const fresh = linePosition({ line: me, others, available, allocations: [] });
      const old = legacyNet({ lineId: me.id, lines: LINES, available });
      assert.equal(fresh.net, old, `net disagreed for line ${me.id} at available=${available}`);
      assert.equal(fresh.short, Math.max(0, -old), `short disagreed for line ${me.id} at available=${available}`);
    }
  }
});

test('linePosition: a hold covers the holder and pushes everyone else short', () => {
  const allocations = [{ order_line_id: 1, qty: 20000, source: 'stock', status: 'active' }];

  const mine = linePosition({
    line: LINES[0],
    others: LINES.filter(l => l.id !== 1),
    available: 26000,
    allocations,
  });
  assert.equal(mine.held_for_me, 20000);
  assert.equal(mine.my_open_need, 21742);

  const theirs = linePosition({
    line: LINES[1],
    others: LINES.filter(l => l.id !== 2),
    available: 26000,
    allocations,
  });
  assert.equal(theirs.free, 6000, 'the held 20,000 is no longer free');
  assert.equal(theirs.held_for_me, 0);
  assert.equal(theirs.my_open_need, 20000);
});

test('linePosition: only planned/ready lines compete — callers pass the filtered set', () => {
  const p = linePosition({ line: LINES[0], others: [], available: 50000, allocations: [] });
  assert.equal(p.others_open_need, 0);
  assert.equal(p.short, 0);
});

// ── BUG 1 regression: the line being planned must never be guessed at ───────
test('linePosition throws when the line being planned is missing', () => {
  assert.throws(() => linePosition({ line: null, others: [], available: 100 }));
  assert.throws(() => linePosition({ line: undefined, others: [], available: 100 }));
  assert.throws(() => linePosition({ line: {}, others: [], available: 100 }));
});

test('linePosition: a pending line (not in others) still counts its own need', () => {
  const p = linePosition({
    line: { id: 501, parent_sheets_required: 41742 },
    others: [{ id: 2, parent_sheets_required: 20000 }],
    available: 26000,
    allocations: [],
  });
  assert.equal(p.need, 41742);
  assert.equal(p.my_open_need, 41742);
  assert.equal(p.net, -35742);
  assert.equal(p.short, 35742);
});

// ── BUG 2 regression: board held beyond what a job can use stays free ───────
test('boardPosition: a hold beyond the holder\'s need stays free, reported as over_held', () => {
  const p = boardPosition({
    available: 26000,
    allocations: [{ order_line_id: 1, qty: 20000, source: 'stock', status: 'active' }],
    lines: [{ id: 1, parent_sheets_required: 1000 }],
  });
  assert.equal(p.held, 1000);
  assert.equal(p.over_held, 19000);
  assert.equal(p.free, 25000);
});

test('linePosition: over-held board is available to a competing line, not phantom-short', () => {
  const p = linePosition({
    line: { id: 2, parent_sheets_required: 10000 },
    others: [{ id: 1, parent_sheets_required: 1000 }],
    available: 26000,
    allocations: [{ order_line_id: 1, qty: 20000, source: 'stock', status: 'active' }],
  });
  assert.equal(p.short, 0, 'not 4000 — the 19,000 surplus held for line 1 must free up for line 2');
});

test('boardPosition: an unknown line\'s hold counts at face value (conservative)', () => {
  const p = boardPosition({
    available: 26000,
    allocations: [{ order_line_id: 99, qty: 20000, source: 'stock', status: 'active' }],
    lines: [],
  });
  assert.equal(p.held, 20000);
  assert.equal(p.free, 6000);
  assert.equal(p.over_held, 0);
});

// ── materialId filtering ──────────────────────────────────────────────────
test('linePosition: materialId filters out allocations for a different material', () => {
  const p = linePosition({
    line: { id: 1, parent_sheets_required: 5000 },
    others: [],
    available: 6000,
    allocations: [{ order_line_id: 7, qty: 30000, source: 'stock', status: 'active', material_id: 999 }],
    materialId: 7,
  });
  assert.equal(p.short, 0);
  assert.equal(p.free, 6000);
});

test('linePosition: without materialId, no filtering happens (back-compat)', () => {
  const p = linePosition({
    line: { id: 1, parent_sheets_required: 5000 },
    others: [],
    available: 6000,
    allocations: [{ order_line_id: 7, qty: 30000, source: 'stock', status: 'active', material_id: 999 }],
  });
  assert.equal(p.free, -24000);
});
