import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcilePastingRow } from './routes/production.js';

// The one invariant this whole station hangs on: SEQUENTIAL work never sums.
//
// "Machine + hand" and "Split batch" put the same two numbers on the screen and
// mean opposite things. A machine that side-pastes 30,000 pieces which are then
// hand-locked is THIRTY thousand cartons, not fifty-nine — the two steps are the
// same pile. A split batch of 50k by machine and 50k by hand is one hundred
// thousand, because they are different piles. Confusing the two either doubles
// the plant's output on paper or halves it.
const row = o => reconcilePastingRow(o, 0);

test('machine only', () => {
  const r = row({ method: 'machine', input_qty: 100, auto_qty: 100 });
  assert.equal(r.good_qty, 100);
  assert.equal(r.waste_qty, 0);
});

test('hand only', () => {
  const r = row({ method: 'manual', input_qty: 100, manual_qty: 90, waste_qty: 10 });
  assert.equal(r.good_qty, 90);
  assert.equal(r.waste_qty, 10);
});

test('machine → hand, same pieces (SEQUENTIAL)', async t => {
  await t.test('Anik\'s case: side by machine 30k, hand pasting 29k, 1000 wastage', () => {
    // The case the old rule REJECTED outright: it demanded machine === hand,
    // which assumes nothing is ever lost at the lock step.
    const r = row({ method: 'machine_manual', input_qty: 30000, auto_qty: 30000, manual_qty: 29000, waste_qty: 1000, waste_reason: 'Crease break' });
    assert.equal(r.good_qty, 29000, 'good is the LAST step — what actually got locked');
    assert.equal(r.waste_qty, 1000);
  });

  await t.test('never sums the two steps — 30k + 29k is not 59k', () => {
    const r = row({ method: 'machine_manual', input_qty: 30000, auto_qty: 30000, manual_qty: 29000, waste_qty: 1000, waste_reason: 'x' });
    assert.notEqual(r.good_qty, 59000);
    assert.ok(r.good_qty <= 30000, 'a sequential row can never output more than it took in');
  });

  await t.test('no loss — the old equal-counts case still behaves identically', () => {
    const r = row({ method: 'machine_manual', input_qty: 30000, auto_qty: 30000, manual_qty: 30000 });
    assert.equal(r.good_qty, 30000);
    assert.equal(r.waste_qty, 0);
  });

  await t.test('loss at BOTH steps — machine drops 500, hand drops another 500', () => {
    const r = row({ method: 'machine_manual', input_qty: 30000, auto_qty: 29500, manual_qty: 29000, waste_qty: 1000, waste_reason: 'x' });
    assert.equal(r.good_qty, 29000);
  });

  await t.test('hand locking MORE than the machine side-pasted self-corrects, never blocks', () => {
    // Anik: "side pasting made 2000, manual recorded 2200 — allow it, and modify
    // the side pasting automatically as there might be a counter mistake, but
    // keep an audit trail." You cannot lock a piece that was never side-pasted,
    // so the machine count is the one that was miscounted.
    const r = row({ method: 'machine_manual', input_qty: 2200, auto_qty: 2000, manual_qty: 2200 });
    assert.equal(r.auto_qty, 2200, 'the machine step is raised to match');
    assert.equal(r.good_qty, 2200);
    assert.equal(r.waste_qty, 0);
    assert.deepEqual(r.step_correction, { from: 2000, to: 2200, delta: 200 },
      'and the correction is recorded rather than silently applied');
  });

  await t.test('no correction is recorded when the two steps are consistent', () => {
    assert.equal(row({ method: 'machine_manual', input_qty: 30000, auto_qty: 30000, manual_qty: 29000, waste_qty: 1000, waste_reason: 'x' }).step_correction, null);
  });

  await t.test('a machine count above the row input is raised WITH the input, not blocked', () => {
    // Over-receipt: more pieces reached the bench than the paperwork expected.
    const r = row({ method: 'machine_manual', input_qty: 30000, auto_qty: 31000, manual_qty: 31000 });
    assert.equal(r.good_qty, 31000);
    assert.equal(r.input_qty, 31000, 'the row admits what it actually consumed');
  });
});

test('split batch, different pieces (PARALLEL)', async t => {
  await t.test('Anik\'s case: 1 lac cartons — 50k machine, 50k hand contractor', () => {
    const r = row({ method: 'split', input_qty: 100000, auto_qty: 50000, manual_qty: 50000 });
    assert.equal(r.good_qty, 100000, 'different piles DO sum');
    assert.equal(r.waste_qty, 0);
  });

  await t.test('split with wastage', () => {
    const r = row({ method: 'split', input_qty: 100000, auto_qty: 50000, manual_qty: 49000, waste_qty: 1000, waste_reason: 'Sheet damage' });
    assert.equal(r.good_qty, 99000);
  });
});

test('per-stream operators are carried through', async t => {
  await t.test('split — Shankar on the machine, Jieut by hand', () => {
    const r = row({ method: 'split', input_qty: 100000, auto_qty: 50000, manual_qty: 50000,
      auto_operator: 'Shankar', manual_operator: 'Jieut Pasting' });
    assert.equal(r.auto_operator, 'Shankar');
    assert.equal(r.manual_operator, 'Jieut Pasting');
  });

  await t.test('a stream with no quantity carries no operator', () => {
    // Otherwise a stale name from a switched method reads as though that person
    // worked the job.
    const r = row({ method: 'machine', input_qty: 100, auto_qty: 100, manual_operator: 'Jieut Pasting' });
    assert.equal(r.manual_operator, null);
  });

  await t.test('blank operators normalise to null, not empty string', () => {
    const r = row({ method: 'machine', input_qty: 100, auto_qty: 100, auto_operator: '   ' });
    assert.equal(r.auto_operator, null);
  });
});

test('an UNDER-covered row is still an error — the shortfall must be declared as waste', () => {
  // Under and over are not symmetrical. Pieces that entered and did not come out
  // went somewhere, so the form derives them as waste and the row must say so.
  // Over-delivery is a counting fact and is never blocked (see below).
  assert.throws(() => row({ method: 'machine', input_qty: 100, auto_qty: 90 }), /must equal/);
  assert.throws(() => row({ method: 'split', input_qty: 100, auto_qty: 40, manual_qty: 40 }), /must equal/);
});

test('OVER-production is absorbed, never rejected', () => {
  // "expected from die cut based upon sheet is 13900 but output is 14200 — allow
  // it." The row records what was really produced; the discrepancy is reported
  // by the caller, not blocked here.
  const r = row({ method: 'machine', input_qty: 13900, auto_qty: 14200 });
  assert.equal(r.good_qty, 14200);
  assert.equal(r.input_qty, 14200, 'input rises to what actually came through');
  assert.equal(r.waste_qty, 0);
});

test('a machine-only row rejects a hand quantity, and vice versa', () => {
  assert.throws(() => row({ method: 'machine', input_qty: 100, auto_qty: 100, manual_qty: 5 }), /hand quantity/);
  assert.throws(() => row({ method: 'manual', input_qty: 100, manual_qty: 100, auto_qty: 5 }), /machine quantity/);
});
