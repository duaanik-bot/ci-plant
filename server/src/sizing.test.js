import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readings, cartonPlan, layoutOn, sheetLadder, proposals, layoutBlocks } from '../../client/src/lib/sizing.js';

// The size proposals engine (owner, 12 Nov 2026: "you propose the best sizes to me … out of which I will select one").
// Its rules were measured from the plant's own dies and output sheets, so the first test is that it gives the ups the
// real dies run. Board sizes here are mill sizes the plant stocks; nothing is a customer's.

const best = (style, [l, w, h], a, b) => {
  const long = Math.max(a, b), short = Math.min(a, b);
  let top = 0;
  for (const r of readings(style, { l, w, h })) {
    const plan = cartonPlan(r);
    for (const on of ['long', 'short']) top = Math.max(top, layoutOn(plan, long, short, on).ups);
  }
  return top;
};

test('known dies: the plan gives the ups the real die runs', () => {
  const dies = [
    ['LOCK', [131, 70, 57], 18, 23, 4], ['SIDE', [85, 37, 50], 18, 23, 9], ['SIDE', [75, 35, 48], 14, 22, 8],
    ['LOCK', [120, 62, 70], 15, 25, 4], ['LOCK', [85, 85, 70], 14, 22, 3], ['LOCK', [158, 85, 93], 15.75, 20.75, 2],
    ['SIDE', [65, 40, 100], 19, 26, 8], ['LOCK', [135, 83, 80], 18, 23, 3], ['SIDE', [125, 15, 80], 16, 25, 8],
    ['SIDE', [165, 15, 95], 18, 25, 6], ['LOCK', [165, 55, 100], 13.5, 18, 2],
  ];
  for (const [style, size, a, b, real] of dies) {
    assert.equal(best(style, size, a, b), real, `${style} ${size.join('x')} on ${a}x${b}`);
  }
});

test('a side-pasted carton is read side-open and top-open; a lock bottom one way', () => {
  assert.deepEqual(readings('SIDE', { l: 65, w: 40, h: 100 }).map(r => [r.key, r.construction, r.tube, r.face, r.w]),
    [['side-open', 'RTE', 65, 100, 40], ['top-open', 'RTE', 100, 65, 40]]);
  assert.deepEqual(readings('LOCK', { l: 92, w: 80, h: 66 }).map(r => [r.key, r.construction, r.tube, r.face, r.w]),
    [['lock', 'LOCK', 66, 92, 80]]);
  assert.deepEqual(readings('LIT', { l: 150, w: 240 }), []);
});

test('blank sizes follow the house rules', () => {
  const rte = cartonPlan(readings('SIDE', { l: 65, w: 40, h: 100 })[1]);
  assert.equal(rte.across, 220);            // 2 × 65 + 2 × 40 + glue 10
  assert.equal(rte.along(1), 204);          // 100 + 2 × (40 + tuck 12)
  assert.equal(rte.along(2), 356);          // tucks interleave: every 100 + 40 + 12
  const lock = cartonPlan(readings('LOCK', { l: 92, w: 80, h: 66 })[0]);
  assert.equal(lock.across, 359);           // 2 × 92 + 2 × 80 + glue 15
  assert.equal(lock.along(1), 205);         // lock 45 + 66 + 80 + tuck 14
  assert.equal(lock.along(2), 316);         // head to head: one W + tuck gap
});

const MILLS = [
  { id: 1, sheet_l: 25, sheet_w: 30, grain: null }, { id: 2, sheet_l: 23, sheet_w: 36, grain: null },
  { id: 3, sheet_l: 25, sheet_w: 36, grain: null }, { id: 4, sheet_l: 31.5, sheet_w: 41.5, grain: null },
  { id: 5, sheet_l: 22, sheet_w: 28, grain: null },
];

test('the sheet ladder offers whole pieces of stocked mill sheets', () => {
  const lad = sheetLadder(MILLS);
  const half = lad.find(s => s.long === 23 && s.short === 18);
  assert.ok(half, '18 × 23 is offered');
  assert.equal(half.mill.long, 36);
  assert.equal(half.pieces, 2);
  assert.equal(half.use, 1);
  assert.ok(lad.every(s => s.long <= 28 && s.short <= 20 && s.short >= 10), 'inside the press window');
});

test('grain: a long-grain 23 × 36 gives an 18 × 23 child with the grain on its 18 in side', () => {
  const known = sheetLadder([{ id: 2, sheet_l: 23, sheet_w: 36, grain: 'long' }]).find(s => s.long === 23 && s.short === 18);
  assert.equal(known.grainSide, 'short');
  const unknown = sheetLadder([{ id: 2, sheet_l: 23, sheet_w: 36, grain: null }]).find(s => s.long === 23 && s.short === 18);
  assert.equal(unknown.grainSide, null);
});

test('proposals rank least board first: 92 × 80 × 66 lock bottom on 15 × 25, 4 up', () => {
  const p = proposals({ style: 'LOCK', size: { l: 92, w: 80, h: 66 }, boards: MILLS, gsm: 300 });
  const top = p.readings[0].options[0];
  assert.deepEqual([top.sheet.long, top.sheet.short, top.ups], [25, 15, 4]);
  assert.equal(top.grain, 'unknown');
  assert.ok(Math.abs(top.gramsPerCarton - 18.1) < 0.1);
  const per = p.readings[0].options.map(o => o.sqInPerCarton);
  assert.deepEqual(per, [...per].sort((a, b) => a - b));
  assert.equal(new Set(p.readings[0].options.map(o => o.ups)).size, p.readings[0].options.length, 'one option per ups');
});

test('a near miss is reported: 85 × 63 × 78 lock bottom fits 4 up on 12 × 25 with about 1.2 mm less', () => {
  const p = proposals({ style: 'LOCK', size: { l: 85, w: 63, h: 78 }, boards: MILLS, gsm: 320 });
  const miss = p.readings[0].nearMisses.find(m => m.sheet.long === 25 && m.sheet.short === 12);
  assert.ok(miss, 'the 12 × 25 near miss');
  assert.equal(miss.ups, 4);
  assert.ok(miss.needMm > 1 && miss.needMm < 1.5, `needs ${miss.needMm} mm`);
});

test('styles the engine does not draw, and cartons no sheet takes, say why', () => {
  const lit = proposals({ style: 'LIT', size: { l: 150, w: 240 }, boards: MILLS });
  assert.equal(lit.unsupported, true);
  assert.match(lit.reason, /side pasting|lock bottom/i);
  const huge = proposals({ style: 'LOCK', size: { l: 400, w: 300, h: 300 }, boards: MILLS });
  assert.equal(huge.readings[0].options.length, 0);
  assert.match(huge.reason, /press/i);
});

test('the layout picture puts every up inside the sheet', () => {
  const p = proposals({ style: 'SIDE', size: { l: 65, w: 40, h: 100 }, boards: [{ id: 9, sheet_l: 26, sheet_w: 38, grain: null }] });
  const r = p.readings.find(x => x.reading.key === 'top-open');
  const o = r.options.find(x => x.sheet.long === 26 && x.sheet.short === 19);
  assert.equal(o.ups, 8);
  const blocks = layoutBlocks(r.plan, r.reading, o);
  assert.equal(blocks.filter(b => b.kind === 'body').length, 8);
  const W = o.sheet.long * 25.4, H = o.sheet.short * 25.4;
  for (const b of blocks) assert.ok(b.x >= -0.01 && b.y >= -0.01 && b.x + b.w <= W + 0.6 && b.y + b.h <= H + 0.6, JSON.stringify(b));
});

test('the die register loader keeps one row per die number and only rows with a whole size', async () => {
  const { registerRows } = await import('../../scripts/load-die-register.mjs');
  const rows = registerRows([
    { die: '406', L: 85, W: 75, H: 90, past: 'Lock ', ups: '2', size: '85X75X90' },
    { die: '406', L: 99, W: 99, H: 99, past: 'RTF', ups: '1', size: '99X99X99' },
    { die: '407', L: 120, W: null, H: 60, past: 'RTF', ups: '4', size: '120X?X60' },
    { die: ' 2077 ', L: 105, W: 18, H: 45, past: 'RTF', ups: '12', size: '105X18X45' },
  ]);
  assert.deepEqual(rows, [
    { die_no: '406', l_mm: 85, w_mm: 75, h_mm: 90, style: 'LOCK', ups: 2, size_text: '85X75X90' },
    { die_no: '2077', l_mm: 105, w_mm: 18, h_mm: 45, style: 'SIDE', ups: 12, size_text: '105X18X45' },
  ]);
});

test('an existing layout is read back: which reading, how many across and along, which side across', async () => {
  const { inferLayout } = await import('../../client/src/lib/sizing.js');
  const lock = inferLayout({ style: 'LOCK', size: { l: 92, w: 80, h: 66 }, sheet_l: 15, sheet_w: 25, ups: 4 });
  assert.equal(lock.reading.key, 'lock');
  assert.deepEqual([lock.option.m, lock.option.n, lock.option.acrossOn, lock.option.sheet.long, lock.option.sheet.short], [1, 4, 'short', 25, 15]);
  const side = inferLayout({ style: 'SIDE', size: { l: 65, w: 40, h: 100 }, sheet_l: 19, sheet_w: 26, ups: 8 });
  assert.equal(side.reading.key, 'top-open');
  assert.deepEqual([side.option.m, side.option.n], [2, 4]);
  const fewer = inferLayout({ style: 'LOCK', size: { l: 85, w: 85, h: 70 }, sheet_l: 14, sheet_w: 22, ups: 2 });
  assert.equal(fewer.option.m * fewer.option.n, 2, 'a die with fewer ups than the sheet takes');
  assert.equal(inferLayout({ style: 'LOCK', size: { l: 92, w: 80, h: 66 }, sheet_l: 10, sheet_w: 12, ups: 4 }), null);
});
