import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rowGood, rowInput, rowStepCorrection, buildRowPayloads } from '../../client/src/lib/pastingRows.js';
import { reconcilePastingRow } from './routes/production.js';

// The client half of the sequential-vs-parallel invariant. The server rejects a
// bad grid, but by then the operator has already typed everything and lost the
// modal — so the same arithmetic is proven here, and the two are checked against
// each other at the bottom of this file.

test('rowGood: sequential reports the LAST step, split reports the sum', () => {
  assert.equal(rowGood({ method: 'machine_manual', auto: 30000, manual: 29000 }), 29000);
  assert.equal(rowGood({ method: 'split', auto: 50000, manual: 50000 }), 100000);
  assert.equal(rowGood({ method: 'machine', auto: 100 }), 100);
  assert.equal(rowGood({ method: 'manual', manual: 100 }), 100);
});

test('a sequential row claims the pieces lost between its own two steps', () => {
  // 30,000 in, 29,000 locked → the row's input is the full 30,000 it consumed.
  const r = { method: 'machine_manual', auto: 30000, manual: 29000 };
  assert.equal(rowInput(r), 30000);
  assert.equal(rowGood(r), 29000);
});

test('rowStepCorrection reports the machine step being raised, and never blocks', () => {
  // "side pasting made 2000, manual recorded 2200 — allow it, and modify the
  // side pasting automatically, but keep an audit trail."
  assert.deepEqual(rowStepCorrection({ method: 'machine_manual', auto: 2000, manual: 2200 }),
    { from: 2000, to: 2200, delta: 200 });
  assert.equal(rowStepCorrection({ method: 'machine_manual', auto: 30000, manual: 29000 }), null);
  assert.equal(rowStepCorrection({ method: 'split', auto: 1, manual: 99999 }), null); // parallel: fine

  // The corrected row still balances all the way through the server.
  const payloads = buildRowPayloads([{ method: 'machine_manual', auto: 2000, manual: 2200 }], 0, '');
  const server = reconcilePastingRow(payloads[0], 0);
  assert.equal(server.good_qty, 2200);
  assert.equal(server.auto_qty, 2200, 'machine raised to match');
  assert.deepEqual(server.step_correction, { from: 2000, to: 2200, delta: 200 });
});

test('over-production flows through the grid without a blocker', () => {
  // Die cutting expected 13,900; the bench counted 14,200.
  const rows = [{ method: 'machine', auto: 14200 }];
  const pool = 13900;
  const payloads = buildRowPayloads(rows, Math.max(0, pool - rowGood(rows[0])), '');
  assert.equal(payloads[0].input_qty, 14200);
  assert.equal(payloads[0].waste_qty, 0, 'a surplus is not waste');
  const server = reconcilePastingRow(payloads[0], 0);
  assert.equal(server.good_qty, 14200);
});

test('Anik\'s cases, end to end through the grid builder', async t => {
  await t.test('side by machine 30k, hand 29k, 1000 wastage', () => {
    const rows = [{ method: 'machine_manual', auto: 30000, manual: 29000, machine_id: 3 }];
    const pool = 30000, good = rows.reduce((s, r) => s + rowGood(r), 0);
    const payloads = buildRowPayloads(rows, pool - good, 'Crease break');
    assert.equal(payloads.length, 1);
    assert.equal(payloads[0].auto_qty, 30000);
    assert.equal(payloads[0].manual_qty, 29000);
    assert.equal(payloads[0].waste_qty, 1000, 'the 1,000 is waste ONCE, not twice');
    assert.equal(payloads[0].input_qty, 30000);
    // The server must accept exactly this and agree on the output.
    const server = reconcilePastingRow(payloads[0], 0);
    assert.equal(server.good_qty, 29000);
  });

  await t.test('1 lac cartons — 50k Shankar on machine, 50k Jieut by hand', () => {
    const rows = [{ method: 'split', auto: 50000, manual: 50000, machine_id: 3,
      auto_operator: 'Shankar', manual_operator: 'Jieut Pasting' }];
    const payloads = buildRowPayloads(rows, 0, '');
    assert.equal(payloads[0].input_qty, 100000);
    assert.equal(payloads[0].waste_qty, 0);
    const server = reconcilePastingRow(payloads[0], 0);
    assert.equal(server.good_qty, 100000);
    assert.equal(server.auto_operator, 'Shankar');
    assert.equal(server.manual_operator, 'Jieut Pasting');
  });

  await t.test('a sequential row that is NOT row 1 still balances', () => {
    // The regression the old "dump all waste on row 1" rule would have caused:
    // row 2's machine count would exceed row 2's own input.
    const rows = [
      { method: 'machine', auto: 10000, machine_id: 3 },
      { method: 'machine_manual', auto: 20000, manual: 19000, machine_id: 3 },
    ];
    const pool = 30000, good = rows.reduce((s, r) => s + rowGood(r), 0);   // 10000 + 19000
    const payloads = buildRowPayloads(rows, pool - good, 'Crease break');
    assert.equal(payloads.reduce((s, p) => s + p.input_qty, 0), pool,
      'the rows must cover the sorted-good pool exactly');
    // Both rows must survive the server's own reconciliation.
    const back = payloads.map((p, i) => reconcilePastingRow(p, i));
    assert.equal(back[1].good_qty, 19000);
    assert.equal(back.reduce((s, b) => s + b.good_qty, 0), 29000);
  });

  await t.test('the grid always covers the pool exactly, for every method', () => {
    const pool = 100000;
    for (const rows of [
      [{ method: 'machine', auto: 90000 }],
      [{ method: 'manual', manual: 90000 }],
      [{ method: 'machine_manual', auto: 95000, manual: 90000 }],
      [{ method: 'split', auto: 45000, manual: 45000 }],
      [{ method: 'split', auto: 50000, manual: 50000 }],
    ]) {
      const good = rows.reduce((s, r) => s + rowGood(r), 0);
      const payloads = buildRowPayloads(rows, pool - good, 'Sheet damage');
      const total = payloads.reduce((s, p) => s + p.input_qty, 0);
      assert.equal(total, pool, `${rows[0].method} covered ${total} of ${pool}`);
      // And the server agrees the good figure is what the screen showed.
      const serverGood = payloads.reduce((s, p, i) => s + reconcilePastingRow(p, i).good_qty, 0);
      assert.equal(serverGood, good);
    }
  });
});

test('a blank method contributes nothing — it must never fall through to the sum', () => {
  // Clearing the Method box used to leave the row summing machine + hand, so a
  // 10,000-piece sequential row read as 20,000 and the grid claimed to have
  // over-pasted the pool.
  assert.equal(rowGood({ method: '', auto: 10000, manual: 10000 }), 0);
  assert.equal(rowGood({ method: undefined, auto: 10000, manual: 10000 }), 0);
  assert.deepEqual(buildRowPayloads([{ method: '', auto: 10000, manual: 10000 }], 0, ''), []);
});

test('a sequential row is never summed — the 59,000 bug', () => {
  const rows = [{ method: 'machine_manual', auto: 30000, manual: 29000 }];
  const payloads = buildRowPayloads(rows, 1000, 'x');
  const good = reconcilePastingRow(payloads[0], 0).good_qty;
  assert.notEqual(good, 59000);
  assert.equal(good, 29000);
});
