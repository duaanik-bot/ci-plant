import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sharedLayoutRun, splitProportional, agreedChildSize } from './shared-layout.js';

test('sharedLayoutRun', async t => {
  await t.test('Niko Standard, ratio-matched orders: MAX, not SUM', () => {
    // 19x20 sheet · Niko1 8 ups · Niko2 4 ups · orders 80,000 / 40,000.
    const r = sharedLayoutRun([{ id: 1, net: 80000, ups: 8 }, { id: 2, net: 40000, ups: 4 }]);
    assert.equal(r.run_child, 10000);      // NOT 20,000 — one sheet prints both
    assert.equal(r.total_ups, 12);
    assert.deepEqual(r.per.map(p => p.overs), [0, 0]); // perfect ratio → no overs
  });

  await t.test('ratio mismatch: the larger need sets the run and the other gains overs', () => {
    const r = sharedLayoutRun([{ id: 1, net: 80000, ups: 8 }, { id: 2, net: 50000, ups: 4 }]);
    assert.equal(r.run_child, 12500);                    // 50,000 / 4 wins
    assert.equal(r.per[0].pieces, 100000);               // Niko1 yielded 100k
    assert.equal(r.per[0].overs, 20000);                 // 20k beyond its order
    assert.equal(r.per[1].overs, 0);
  });

  await t.test('the dynamic 3-job layout (2 / 1 / 3 ups)', () => {
    const r = sharedLayoutRun([
      { id: 1, net: 10000, ups: 2 },   // 5,000 sheets
      { id: 2, net: 6000, ups: 1 },    // 6,000 sheets ← sets the run
      { id: 3, net: 15000, ups: 3 },   // 5,000 sheets
    ]);
    assert.equal(r.run_child, 6000);
    assert.equal(r.total_ups, 6);
    assert.deepEqual(r.per.map(p => p.overs), [2000, 0, 3000]);
  });

  await t.test('wastage is a SINGLE allowance on the run, never per member', () => {
    const r = sharedLayoutRun([{ id: 1, net: 8000, ups: 8 }, { id: 2, net: 4000, ups: 4 }], { wastage: 200 });
    assert.equal(r.need_child, 1000);
    assert.equal(r.run_child, 1200);   // +200 once, not +200 × members
  });

  await t.test('a member without ups refuses loudly — a layout is meaningless without it', () => {
    assert.throws(() => sharedLayoutRun([{ id: 1, net: 100, ups: 0 }]), /needs its ups/);
    assert.throws(() => sharedLayoutRun([{ id: 1, net: 100, ups: null }]), /needs its ups/);
  });

  await t.test('empty members → an empty, zeroed run', () => {
    assert.deepEqual(sharedLayoutRun([]), { run_child: 0, need_child: 0, total_ups: 0, per: [] });
  });
});

test('splitProportional', async t => {
  await t.test('shares follow the ups and sum EXACTLY to the total', () => {
    const parts = splitProportional(10000, [{ id: 1, ups: 8 }, { id: 2, ups: 4 }]);
    assert.deepEqual(parts, [{ id: 1, share: 6667 }, { id: 2, share: 3333 }]);
    assert.equal(parts.reduce((s, p) => s + p.share, 0), 10000);
  });

  await t.test('awkward ratios still sum exactly (largest remainder)', () => {
    const parts = splitProportional(1000, [{ id: 1, ups: 2 }, { id: 2, ups: 1 }, { id: 3, ups: 3 }]);
    assert.equal(parts.reduce((s, p) => s + p.share, 0), 1000);
  });

  await t.test('zero total → all zero; empty members → []', () => {
    assert.deepEqual(splitProportional(0, [{ id: 1, ups: 8 }]), [{ id: 1, share: 0 }]);
    assert.deepEqual(splitProportional(500, []), []);
  });
});

test('agreedChildSize — the soft side of Layout Pending', async t => {
  await t.test('every member on one size → that size (CI-GANG-0005: three 15.75×20.75 cartons)', () => {
    assert.deepEqual(agreedChildSize([
      { l: 15.75, w: 20.75 }, { l: 15.75, w: 20.75 }, { l: 15.75, w: 20.75 },
    ]), { l: 15.75, w: 20.75 });
  });

  await t.test('string sizes from a jsonb override still agree with numeric masters', () => {
    assert.deepEqual(agreedChildSize([{ l: '15.75', w: '20.75' }, { l: 15.75, w: 20.75 }]),
      { l: 15.75, w: 20.75 });
  });

  await t.test('a member with no size anywhere → null (the press has no sheet to run)', () => {
    assert.equal(agreedChildSize([{ l: 15.75, w: 20.75 }, { l: null, w: null }]), null);
    assert.equal(agreedChildSize([{ l: 15.75, w: 20.75 }, { l: 0, w: 20.75 }]), null);
  });

  await t.test('disagreeing sizes → null (one shared layout is ONE sheet)', () => {
    assert.equal(agreedChildSize([{ l: 15.75, w: 20.75 }, { l: 18, w: 23 }]), null);
  });

  await t.test('no members → null', () => {
    assert.equal(agreedChildSize([]), null);
    assert.equal(agreedChildSize(), null);
  });
});
