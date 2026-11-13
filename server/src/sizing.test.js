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

// Owner, 12 Nov 2026 ("FIX THIS BLOCKER"): Make KLD refused 100 × 15 × 80 side pasting at 10 up on 16 × 25 — a die in
// the factory runs exactly that, while the measured rules fit 9. No hard blocker: the layout still comes back, with
// how far it runs past the rules, and the KLD says so.
test('a layout the house rules cannot place still comes back, with how far it runs over', async () => {
  const { inferLayout, closestLayout } = await import('../../client/src/lib/sizing.js');
  const args = { style: 'SIDE', size: { l: 100, w: 15, h: 80 }, sheet_l: 16, sheet_w: 25, ups: 10 };
  assert.equal(inferLayout(args), null);
  const x = closestLayout(args);
  assert.equal(x.reading.key, 'side-open');
  assert.deepEqual([x.option.m, x.option.n, x.option.acrossOn, x.option.ups, x.option.sheet.long, x.option.sheet.short], [2, 5, 'short', 10, 25, 16]);
  assert.deepEqual(x.over, { mm: 15, axis: 'along', rules_ups: 9 });
  // a sheet far too small still gives a grid to draw, with the overrun in full
  const tiny = closestLayout({ style: 'LOCK', size: { l: 92, w: 80, h: 66 }, sheet_l: 10, sheet_w: 12, ups: 4 });
  assert.equal(tiny.option.m * tiny.option.n, 4);
  assert.equal(tiny.over.axis, 'both');
  assert.ok(tiny.over.mm > 0);
  assert.equal(tiny.over.rules_ups, 0);
  assert.equal(closestLayout({ ...args, ups: 0 }), null);
  assert.equal(closestLayout({ ...args, style: 'LIT' }), null);
});

test('a saved layout is checked against the house rules, in words for the panel and the PDF', async () => {
  const { overRules, overRulesText } = await import('../../client/src/lib/sizing.js');
  const [sideOpen] = readings('SIDE', { l: 100, w: 15, h: 80 });
  const lay = { sheet_long: 25, sheet_short: 16, ups: 10, m: 2, n: 5, across_on: 'short' };
  assert.deepEqual(overRules(sideOpen, lay), { mm: 15, axis: 'along', rules_ups: 9 });
  assert.equal(overRules(sideOpen, { ...lay, ups: 8, n: 4 }), null);
  assert.equal(overRulesText({ ...lay, over_rules: overRules(sideOpen, lay) }),
    'By the house rules, 10 up (2 × 5) needs 15 mm more than the 25 in side; they fit 9 up on this sheet. Check the die maker\'s layout.');
  assert.equal(overRulesText({ ...lay, ups: 8, n: 4, over_rules: null }), '');
  assert.equal(overRulesText({ ...lay, ups: 4, m: 1, n: 4, over_rules: { mm: 378, axis: 'both', rules_ups: 0 } }),
    'By the house rules, 4 up (1 × 4) needs up to 378 mm more than the sheet; not one fits this sheet. Check the die maker\'s layout.');
});

// Output layout options (owner, 13 Nov 2026: "key line u are making is good but we need proper layout options also for
// output setting"). The output = the print sheet with every up; its settings (gripper, edges, gap between ups) default
// to the house rules' edge to edge, and every way to place the ups is offered.
const OUT = { style: 'SIDE', size: { l: 100, w: 15, h: 80 }, sheet_l: 16, sheet_w: 25 };
const SET = { gripper: 10, edge: 5, gap: 3 };

test('layout options: every reading, side and grid that makes the ups — the ones that fit first', async () => {
  const { layoutOptions } = await import('../../client/src/lib/sizing.js');
  const nine = layoutOptions({ ...OUT, ups: 9 });
  assert.equal(nine[0].fits, true);
  assert.deepEqual([nine[0].reading.key, nine[0].option.acrossOn, nine[0].option.m, nine[0].option.n], ['side-open', 'long', 3, 3]);
  assert.deepEqual(nine[0].spare, { across: 41, along: 6.4 });
  assert.equal(nine.filter(o => o.fits).length, 1);
  assert.ok(nine.slice(1).every(o => !o.fits && o.over.mm > 0 && o.over.mm <= 150), 'the rest run over, by no more than 150 mm');
  const ten = layoutOptions({ ...OUT, ups: 10 });
  assert.ok(ten.every(o => !o.fits), 'no 10-up fits by the rules');
  assert.deepEqual([ten[0].reading.key, ten[0].option.acrossOn, ten[0].option.m, ten[0].option.n, ten[0].over.mm, ten[0].over.axis],
    ['side-open', 'short', 2, 5, 15, 'along']);
  for (let i = 1; i < ten.length; i++) assert.ok(ten[i].over.mm >= ten[i - 1].over.mm, 'least over first');
  assert.deepEqual(layoutOptions({ ...OUT, ups: 0 }), []);
  assert.deepEqual(layoutOptions({ ...OUT, style: 'LIT', ups: 9 }), []);
});

test('output settings: a gripper and edges take room off the sheet, a gap goes between every two ups', async () => {
  const { layoutOptions, maxUps, overRules, rulesWith, settingsProblem, outputText } = await import('../../client/src/lib/sizing.js');
  assert.equal(maxUps(OUT), 9);
  assert.equal(maxUps({ ...OUT, settings: SET }), 6);
  const nine = layoutOptions({ ...OUT, ups: 9, settings: SET });
  assert.ok(nine.every(o => !o.fits), 'the 3 × 3 that fits edge to edge runs over with a gripper');
  const [sideOpen] = readings('SIDE', OUT.size);
  const lay = { sheet_long: 25, sheet_short: 16, ups: 9, m: 3, n: 3, across_on: 'long', settings: SET };
  assert.deepEqual(overRules(sideOpen, lay), { mm: 14.6, axis: 'along', rules_ups: 6 });
  assert.equal(overRules(sideOpen, { ...lay, settings: null }), null);
  assert.deepEqual(rulesWith(SET).margin, { gripper: 10, other: 5 });
  assert.equal(rulesWith(SET).gutter, 3);
  assert.equal(rulesWith(null).gutter, 0);
  // what a person can type
  assert.equal(settingsProblem(SET), null);
  assert.equal(settingsProblem({ gripper: 80 }), 'Gripper, edges and gap are millimetres from 0 to 50.');
  assert.equal(settingsProblem({ gap: 'x' }), 'Gripper, edges and gap are millimetres from 0 to 50.');
  assert.equal(outputText({ settings: SET }), 'Gripper 10 mm · edges 5 mm · gap between ups 3 mm');
  assert.equal(outputText({ settings: null }), 'Edge to edge: no gripper, edges or gap');
});

test('the layout picture keeps every up inside the gripper, the edges and the gaps', async () => {
  const { layoutOptions } = await import('../../client/src/lib/sizing.js');
  const six = layoutOptions({ ...OUT, ups: 6, settings: SET }).find(o => o.fits);
  assert.ok(six, 'a 6-up fits with the settings');
  const blocks = layoutBlocks(null, six.reading, six.option);
  const L = six.option.sheet.long * 25.4, S = six.option.sheet.short * 25.4;
  for (const b of blocks) {
    assert.ok(b.x >= 5 - 1e-6 && b.x + b.w <= L - 5 + 1e-6, `x ${b.x}..${b.x + b.w} inside the edges`);
    assert.ok(b.y >= 10 - 1e-6 && b.y + b.h <= S - 5 + 1e-6, `y ${b.y}..${b.y + b.h} below the gripper, inside the edge`);
  }
  // two neighbouring bodies are at least the gap apart
  const bodies = blocks.filter(b => b.kind === 'body');
  const apart = (a, b) => Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w), b.y - (a.y + a.h), a.y - (b.y + b.h));
  for (let i = 0; i < bodies.length; i++) for (let j = i + 1; j < bodies.length; j++) assert.ok(apart(bodies[i], bodies[j]) >= 3 - 1e-6);
});
