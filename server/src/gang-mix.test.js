// The run-mix split. The property that must never break: BOTH marginals are
// exact — every member's rows sum to that member's requirement, and every
// board's shares sum to the sheets the planner wrote against it. A split that
// misses either one writes a mix the release gate then refuses (or, worse,
// waves through) on arithmetic nobody typed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitMixAcrossMembers, runMixFromMembers, pressingOnPlanned } from './gang-mix.js';
import { mixBalance } from './board-mix.js';

const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);

// Assert both marginals for one case, and hand back the split.
function splitAndCheck(members, rows) {
  const split = splitMixAcrossMembers({ members, rows });
  assert.equal(split.length, members.length, 'every member gets an entry');
  for (const m of members) {
    const mine = split.find(s => s.member_id === m.id);
    assert.equal(sum(mine.rows, r => r.sheets), Math.round(m.required),
      `member ${m.id} must draw exactly its requirement`);
    assert.ok(mine.rows.every(r => r.sheets > 0), `member ${m.id} carries no zero rows`);
  }
  for (const row of rows) {
    const spread = sum(split, s => sum(s.rows.filter(r => r.material_id === row.material_id), r => r.sheets));
    assert.equal(spread, Math.round(row.sheets),
      `board ${row.material_id} must be spread exactly, not rounded away`);
  }
  return split;
}

test('the case proportional rounding gets wrong: 33/67 across two equal members', () => {
  // Round each row independently and A takes 17+34=51 against a 50 requirement.
  const split = splitAndCheck(
    [{ id: 1, required: 50 }, { id: 2, required: 50 }],
    [{ material_id: 10, sheets: 33, ups: 4, role: 'planned' },
     { material_id: 11, sheets: 67, ups: 4, role: 'substitute' }]);
  assert.deepEqual(split[0].rows.map(r => [r.material_id, r.sheets]), [[10, 33], [11, 17]]);
  assert.deepEqual(split[1].rows.map(r => [r.material_id, r.sheets]), [[11, 50]]);
});

test("the screenshot's run: 5,100 short 250, covered off a second board", () => {
  const split = splitAndCheck(
    [{ id: 1, required: 1350 }, { id: 2, required: 3750 }],
    [{ material_id: 10, sheets: 4850, ups: 2, role: 'planned' },
     { material_id: 11, sheets: 250, ups: 2, role: 'substitute' }]);
  // The small member sits entirely on the planned board; the substitute lands
  // on the member whose share reaches past 4,850.
  assert.deepEqual(split[0].rows.map(r => r.material_id), [10]);
  assert.deepEqual(split[1].rows.map(r => [r.material_id, r.sheets]), [[10, 3500], [11, 250]]);
});

test('every split member balances under the very gate that will judge it', () => {
  const members = [{ id: 1, required: 1350 }, { id: 2, required: 3750 }];
  const rows = [{ material_id: 10, sheets: 4850, ups: 2, role: 'planned' },
                { material_id: 11, sheets: 250, ups: 2, role: 'substitute' }];
  for (const s of splitMixAcrossMembers({ members, rows })) {
    const required = members.find(m => m.id === s.member_id).required;
    // ups === plannedUps is a hard refusal upstream, so covers === sheets.
    const bal = mixBalance({ required, rows: s.rows.map(r => ({ covers: r.sheets })) });
    assert.equal(bal.balanced, true, `member ${s.member_id} must balance`);
  }
});

test('a single member takes the whole mix unchanged', () => {
  const split = splitAndCheck(
    [{ id: 7, required: 900 }],
    [{ material_id: 10, sheets: 700, ups: 3, role: 'planned' },
     { material_id: 11, sheets: 200, ups: 3, role: 'substitute' }]);
  assert.equal(split[0].rows.length, 2);
});

test('a member needing nothing carries no rows, and the rest still balance', () => {
  const split = splitAndCheck(
    [{ id: 1, required: 0 }, { id: 2, required: 400 }, { id: 3, required: 600 }],
    [{ material_id: 10, sheets: 1000, ups: 5, role: 'planned' }]);
  assert.deepEqual(split[0].rows, []);
});

test('row metadata rides along to every member the board lands on', () => {
  const split = splitMixAcrossMembers({
    members: [{ id: 1, required: 30 }, { id: 2, required: 30 }],
    rows: [{ material_id: 11, sheets: 60, ups: 4, role: 'substitute',
             reason: 'Covering with the alternate board', stock_batch_id: 88 }],
  });
  for (const s of split) {
    assert.equal(s.rows[0].reason, 'Covering with the alternate board');
    assert.equal(s.rows[0].stock_batch_id, 88);
    assert.equal(s.rows[0].ups, 4);
    assert.equal(s.rows[0].role, 'substitute');
  }
});

test('mismatched totals throw rather than short-change the last member', () => {
  assert.throws(() => splitMixAcrossMembers({
    members: [{ id: 1, required: 50 }, { id: 2, required: 50 }],
    rows: [{ material_id: 10, sheets: 90 }],
  }), /90 sheets against 100 required/);
  assert.throws(() => splitMixAcrossMembers({
    members: [{ id: 1, required: 50 }],
    rows: [{ material_id: 10, sheets: 60 }],
  }), /60 sheets against 50 required/);
});

test('PROPERTY: both marginals hold across many shapes', () => {
  // Deterministic pseudo-random — no Math.random, so a failure reproduces.
  let seed = 12345;
  const rand = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let iter = 0; iter < 400; iter++) {
    const memberCount = 1 + rand(5);
    const members = Array.from({ length: memberCount }, (_, i) => ({ id: i + 1, required: 1 + rand(2000) }));
    const total = sum(members, m => m.required);
    const rowCount = 1 + rand(4);
    // Carve `total` into rowCount positive parts.
    const cuts = Array.from({ length: rowCount - 1 }, () => 1 + rand(Math.max(1, total - 1))).sort((a, b) => a - b);
    const bounds = [0, ...cuts, total];
    const rows = [];
    for (let i = 0; i < rowCount; i++) {
      const sheets = bounds[i + 1] - bounds[i];
      if (sheets > 0) rows.push({ material_id: 10 + i, sheets, ups: 2, role: i === 0 ? 'planned' : 'substitute' });
    }
    splitAndCheck(members, rows);
  }
});

// ── reading the run's mix back out of its members ──────────────────────────
test('runMixFromMembers re-adds the split into the rows the planner typed', () => {
  const memberRows = [
    { material_id: 10, board_name: 'Saffire · 340 GSM · 20x38', ups: 2, role: 'planned', sheets: 1350, reason: null },
    { material_id: 10, board_name: 'Saffire · 340 GSM · 20x38', ups: 2, role: 'planned', sheets: 3500, reason: null },
    { material_id: 11, board_name: 'Saffire · 350 GSM · 20x38', ups: 2, role: 'substitute', sheets: 250, reason: 'Covering with the alternate board' },
  ];
  const run = runMixFromMembers(memberRows);
  assert.equal(run.length, 2);
  assert.deepEqual(run.map(r => [r.material_id, r.sheets]), [[10, 4850], [11, 250]]);
  assert.equal(run[0].role, 'planned');
  assert.equal(run[1].reason, 'Covering with the alternate board');
});

test('runMixFromMembers puts the planned board first however the rows arrive', () => {
  const run = runMixFromMembers([
    { material_id: 11, ups: 2, role: 'substitute', sheets: 250 },
    { material_id: 10, ups: 2, role: 'planned', sheets: 4850 },
  ]);
  assert.equal(run[0].material_id, 10);
  assert.equal(run[0].role, 'planned');
});

test('runMixFromMembers on an unmixed run is empty, never a phantom row', () => {
  assert.deepEqual(runMixFromMembers([]), []);
  assert.deepEqual(runMixFromMembers(), []);
});

test('a split survives a round trip back to the run figures', () => {
  const members = [{ id: 1, required: 1350 }, { id: 2, required: 3750 }];
  const rows = [
    { material_id: 10, board_name: 'A', ups: 2, role: 'planned', sheets: 4850, reason: null },
    { material_id: 11, board_name: 'B', ups: 2, role: 'substitute', sheets: 250, reason: 'alt' },
  ];
  const flat = splitMixAcrossMembers({ members, rows }).flatMap(s => s.rows);
  assert.deepEqual(runMixFromMembers(flat).map(r => [r.material_id, r.sheets]),
    rows.map(r => [r.material_id, r.sheets]));
});

// ── what the run presses on its planned board ─────────────────────────────
test('pressingOnPlanned: no mix means the whole requirement, exactly as before', () => {
  assert.equal(pressingOnPlanned({ required: 13250, active: false }), 13250);
  assert.equal(pressingOnPlanned({ required: 13250, active: false, covered: 999, heldOnPlanned: 999 }), 13250);
});

test('pressingOnPlanned: a fully covered run presses only what is written against the planned board', () => {
  // 7,950 off the planned board + 5,300 off a substitute = 13,250 covered.
  assert.equal(pressingOnPlanned({ required: 13250, active: true, covered: 13250, heldOnPlanned: 7950 }), 7950);
});

test('pressingOnPlanned: a part-built mix still carries its remainder on the planned board', () => {
  // Only 9,000 allocated so far — the missing 4,250 stays the planned board's.
  assert.equal(pressingOnPlanned({ required: 13250, active: true, covered: 9000, heldOnPlanned: 7950 }), 7950 + 4250);
});

test('pressingOnPlanned: a run covered ENTIRELY off substitutes presses nothing on the planned board', () => {
  assert.equal(pressingOnPlanned({ required: 5000, active: true, covered: 5000, heldOnPlanned: 0 }), 0);
});

test('pressingOnPlanned: an over-allocated mix never goes negative', () => {
  assert.equal(pressingOnPlanned({ required: 5000, active: true, covered: 6000, heldOnPlanned: 4000 }), 4000);
});
