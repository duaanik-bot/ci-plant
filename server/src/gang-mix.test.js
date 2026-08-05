// The run-mix split. The property that must never break: BOTH marginals are
// exact — every member's rows sum to that member's requirement, and every
// board's shares sum to the sheets the planner wrote against it. A split that
// misses either one writes a mix the release gate then refuses (or, worse,
// waves through) on arithmetic nobody typed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitMixAcrossMembers, splitScaledMixAcrossMembers, runMixFromMembers, pressingOnPlanned } from './gang-mix.js';
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

// ── the covers-space split (merge runs with chosen cuts) ───────────────────
// Same two marginals as the integer waterfall, in the units that matter once
// cuts differ: every member's COVERS sum to its requirement exactly (the
// release gate's EPS test), and every board's SHEETS sum to precisely what
// the planner typed (the tail rule — no float dust on the pile).
const EPS = 1e-9;
function scaledSplitAndCheck(members, rows) {
  const split = splitScaledMixAcrossMembers({ members, rows });
  assert.equal(split.length, members.length, 'every member gets an entry');
  for (const m of members) {
    const mine = split.find(s => s.member_id === m.id);
    const covers = sum(mine.rows, r => r.covers);
    assert.ok(Math.abs(covers - m.required) < 1e-6,
      `member ${m.id} covers ${covers} against ${m.required} required`);
    const bal = mixBalance({ required: m.required, rows: mine.rows });
    if (mine.rows.length) assert.equal(bal.balanced, true, `member ${m.id} must balance under the gate`);
  }
  for (const row of rows) {
    const spread = sum(split, s => sum(s.rows.filter(r => r.material_id === row.material_id), r => r.sheets));
    assert.ok(Math.abs(spread - row.sheets) < EPS,
      `board ${row.material_id} spread ${spread} vs ${row.sheets} typed — the tail rule must make this exact`);
  }
  return split;
}

test('scaled split: a double-cut substitute covers twice its sheets', () => {
  // Run needs 100. Planned board 60 sheets at 4 cuts (covers 60); substitute
  // 20 sheets at 8 cuts (covers 40). The integer waterfall would throw here —
  // 80 sheets against 100 required — because sheets are not covers any more.
  const split = scaledSplitAndCheck(
    [{ id: 1, required: 50 }, { id: 2, required: 50 }],
    [{ material_id: 10, sheets: 60, ups: 4, covers: 60, role: 'planned' },
     { material_id: 11, sheets: 20, ups: 8, covers: 40, role: 'substitute' }]);
  // A takes 50 covers off the planned board (50 sheets); B takes the last 10
  // planned covers (10 sheets) and the substitute's 40 covers (20 sheets).
  assert.deepEqual(split[0].rows.map(r => [r.material_id, r.sheets, r.covers]), [[10, 50, 50]]);
  assert.deepEqual(split[1].rows.map(r => [r.material_id, r.sheets, r.covers]), [[10, 10, 10], [11, 20, 40]]);
});

test('scaled split: a board boundary mid-member yields fractional sheets, and the pile still adds to the digit', () => {
  // Substitute of 25 sheets at double cuts covers 50, split 25/25 across two
  // members — 12.5 sheets each. Fractional BOOKKEEPING over one physical
  // pile, by design; the board's own total must come back exactly 25.
  const split = scaledSplitAndCheck(
    [{ id: 1, required: 25 }, { id: 2, required: 25 }],
    [{ material_id: 11, sheets: 25, ups: 6, covers: 50, role: 'substitute' }]);
  assert.deepEqual(split[0].rows.map(r => [r.sheets, r.covers]), [[12.5, 25]]);
  assert.deepEqual(split[1].rows.map(r => [r.sheets, r.covers]), [[12.5, 25]]);
});

test('scaled split: reduced cuts (fewer covers per sheet) walk the same waterfall', () => {
  // 300 sheets at half the planned cuts cover only 150 — a chosen sub-max cut.
  scaledSplitAndCheck(
    [{ id: 1, required: 90 }, { id: 2, required: 160 }],
    [{ material_id: 10, sheets: 100, ups: 4, covers: 100, role: 'planned' },
     { material_id: 11, sheets: 300, ups: 2, covers: 150, role: 'substitute' }]);
});

test('scaled split: equal cuts reproduce the integer waterfall answer', () => {
  const members = [{ id: 1, required: 1350 }, { id: 2, required: 3750 }];
  const rows = [
    { material_id: 10, sheets: 4850, ups: 2, covers: 4850, role: 'planned' },
    { material_id: 11, sheets: 250, ups: 2, covers: 250, role: 'substitute' },
  ];
  const scaled = splitScaledMixAcrossMembers({ members, rows });
  const plain = splitMixAcrossMembers({ members, rows });
  assert.deepEqual(
    scaled.map(s => [s.member_id, s.rows.map(r => [r.material_id, r.sheets])]),
    plain.map(s => [s.member_id, s.rows.map(r => [r.material_id, r.sheets])]));
});

test('scaled split: metadata (lot, reason, ups) rides along on every take', () => {
  const split = splitScaledMixAcrossMembers({
    members: [{ id: 1, required: 30 }, { id: 2, required: 30 }],
    rows: [{ material_id: 11, sheets: 30, ups: 4, covers: 60, role: 'substitute',
             reason: 'Covering with the alternate board', stock_batch_id: 88 }],
  });
  for (const s of split) {
    assert.equal(s.rows[0].reason, 'Covering with the alternate board');
    assert.equal(s.rows[0].stock_batch_id, 88);
    assert.equal(s.rows[0].ups, 4);
  }
});

test('scaled split: unbalanced covers throw rather than short-change the last member', () => {
  assert.throws(() => splitScaledMixAcrossMembers({
    members: [{ id: 1, required: 50 }, { id: 2, required: 50 }],
    rows: [{ material_id: 10, sheets: 45, ups: 4, covers: 90, role: 'planned' }],
  }), /covers 90 against 100 required/);
});

test('PROPERTY: scaled split holds both marginals across cut ratios', () => {
  let seed = 424242;
  const rand = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let iter = 0; iter < 300; iter++) {
    const plannedUps = 2 + rand(6);
    const memberCount = 1 + rand(4);
    const rowCount = 1 + rand(3);
    // Rows first: sheets and each row's own cuts → covers by the ratio.
    const rows = [];
    for (let i = 0; i < rowCount; i++) {
      const sheets = 1 + rand(2000);
      const ups = 1 + rand(9);
      rows.push({ material_id: 10 + i, sheets, ups,
        covers: sheets * ups / plannedUps, role: i === 0 ? 'planned' : 'substitute' });
    }
    const totalCovers = sum(rows, r => r.covers);
    // Members carve the cover total (fractions and all) into positive parts.
    const members = [];
    let left = totalCovers;
    for (let i = 0; i < memberCount - 1; i++) {
      const part = left * ((1 + rand(70)) / 100);
      members.push({ id: i + 1, required: part });
      left -= part;
    }
    members.push({ id: memberCount, required: left });
    scaledSplitAndCheck(members, rows);
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

test('a SCALED split survives the round trip with no float dust on the pile', () => {
  // Ratio 1/3 is the dust maker: 8.333…34 + 16.666…66 re-adds to
  // 25.000000000000004 unsnapped, and stage start would then 409 "short by
  // 4e-15" consuming a pile that is exactly there.
  const members = [{ id: 1, required: 25 }, { id: 2, required: 50 }];
  const rows = [{ material_id: 11, sheets: 25, ups: 6, covers: 75, role: 'substitute' }];
  const flat = splitScaledMixAcrossMembers({ members, rows }).flatMap(s => s.rows);
  const run = runMixFromMembers(flat);
  assert.equal(run.length, 1);
  assert.equal(run[0].sheets, 25, 'the pile must re-add to EXACTLY the typed figure');
  assert.ok(Number.isInteger(run[0].sheets));
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
