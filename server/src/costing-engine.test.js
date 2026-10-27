import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as server from './costing-engine.js';
import * as client from '../../client/src/lib/costing.js';

const { computeCosting, parseSize, normStyle, sizerProposals, compareCostings, CURRENT_FORMULA, FORMULAS } = server;
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} !== ${b}`);

// Invented job — not a real customer's figures.
const JOB = {
  qty: 12000, sheet_l: 20, sheet_w: 30, ups: 6, gsm: 280, board_rate: 90, wastage: 200,
  colours: 4, print_rate: 450, print_min: 1600, coat_factor: 4, dp_rate: 0.25, emb_rate: 0.1,
  process: 1800, pf_pct: 5, misc_pct: 2, margin: 0.05,
};

test('computeCosting: every step follows the cost sheet', () => {
  const r = computeCosting(JOB);
  assert.equal(r.ok, true);
  assert.equal(r.formula, CURRENT_FORMULA);
  const sheets = 12000 / 6 + 200;
  near(r.sheets, sheets);
  const kg = 20 * 30 * 280 / 3100 / 5 / 100;
  near(r.sheet_kg, kg);
  const board = kg * 90 * sheets;
  const print = 450 * 4 * sheets / 1000;
  const coat = 20 * 30 / 4 / 100 * sheets;
  const dp = 0.25 * 12000;
  const subtotal = board + print + coat + dp + 1800;
  const pf = 0.05 * subtotal;
  const misc = 0.02 * (subtotal + pf);
  near(r.parts.board, board);
  near(r.parts.print, print);
  near(r.parts.coat, coat);
  near(r.parts.dp, dp);
  near(r.parts.subtotal, subtotal);
  near(r.parts.pf, pf);
  near(r.parts.misc, misc);
  near(r.cost_per_unit, (subtotal + pf + misc) / 12000 + 0.1);
  near(r.quote_per_unit, r.cost_per_unit + 0.05);
  near(r.cost_value, r.cost_per_unit * 12000);
  assert.equal(r.parts.print_at_min, false);
});

test('computeCosting: printing never goes under the minimum charge', () => {
  const r = computeCosting({ ...JOB, qty: 600, wastage: 100 });
  // 600 ÷ 6 + 100 = 200 sheets × 4 × 450 ÷ 1000 = 360, under 1,600
  near(r.parts.print_calc, 360);
  near(r.parts.print, 1600);
  assert.equal(r.parts.print_at_min, true);
  assert.ok(r.warnings.some(w => w.key === 'print_min'));
});

test('computeCosting: printing exactly AT the minimum is charged the minimum (the sheet tests "more than")', () => {
  // 2,000 sheets × 2 colours × 400 ÷ 1000 = 1,600
  const r = computeCosting({ ...JOB, qty: 10800, ups: 6, wastage: 200, colours: 2, print_rate: 400, print_min: 1600 });
  near(r.parts.print_calc, 1600);
  assert.equal(r.parts.print_at_min, true);
});

test('computeCosting: embossing is added per carton AFTER P&F and misc', () => {
  const a = computeCosting({ ...JOB, emb_rate: 0 });
  const b = computeCosting({ ...JOB, emb_rate: 0.4 });
  near(b.cost_per_unit - a.cost_per_unit, 0.4);
  near(b.parts.pf, a.parts.pf);
});

test('computeCosting: blank coating factor = no coating', () => {
  const r = computeCosting({ ...JOB, coat_factor: '' });
  assert.equal(r.parts.coat, 0);
  assert.equal(r.lines.find(l => l.key === 'coat').how, 'No coating');
});

test('computeCosting: what is missing is named, never treated as 0', () => {
  const r = computeCosting({ ...JOB, gsm: '', ups: 0, board_rate: null });
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing.map(m => m.key), ['ups', 'gsm', 'board_rate']);
  assert.equal(r.cost_per_unit, undefined);
});

test('computeCosting: numbers typed with commas or spaces are read', () => {
  const r = computeCosting({ ...JOB, qty: '12,000', board_rate: ' 90 ' });
  near(r.cost_per_unit, computeCosting(JOB).cost_per_unit);
});

test("computeCosting: customer's target price shows the margin left, and warns when below cost", () => {
  const cost = computeCosting(JOB).cost_per_unit;
  const r = computeCosting({ ...JOB, target_price: 2 });
  near(r.target.margin_per_unit, 2 - cost);
  assert.ok(r.target.margin_per_unit < 0);
  assert.ok(r.warnings.some(w => w.key === 'target_price'));
});

test('formulas: the 2022 sheet ignored embossing and the minimum; the 2023 sheet added embossing', () => {
  const a = computeCosting({ ...JOB, qty: 600, wastage: 100 }, 'SHEET-A');
  assert.equal(a.parts.print_at_min, false);
  near(a.parts.print, 360);
  const net = a.parts.net;
  near(a.cost_per_unit, net / 600);
  const b = computeCosting({ ...JOB, qty: 600, wastage: 100 }, 'SHEET-B');
  near(b.cost_per_unit, b.parts.net / 600 + 0.1);
  assert.throws(() => computeCosting(JOB, 'NOPE'), /Unknown costing formula/);
  assert.deepEqual(Object.keys(FORMULAS), ['SHEET-A', 'SHEET-B', 'CI-1']);
});

test('formulas: a printing amount typed on the old sheet, and a floor under a higher threshold, are kept', () => {
  near(computeCosting({ ...JOB, print_fixed: 2500 }).parts.print, 2500);
  const r = computeCosting({ ...JOB, qty: 600, wastage: 100, print_min: 5000, print_min_floor: 3000 });
  near(r.parts.print, 3000);
});

test('parseSize: the ways a size was typed all read to one key, order kept', () => {
  for (const t of ['165x58x73', '165X58X73', ' 165 x 58 x 73 ', '165*58*73', '165×58×73 MM', '165XX58X73', '165X58X73R0']) {
    assert.equal(parseSize(t).key, '165x58x73', t);
  }
  assert.equal(parseSize('58x165x73').key, '58x165x73');
  assert.deepEqual([parseSize('100X140').kind, parseSize('100X140').key], ['flat', '100x140']);
  assert.equal(parseSize('130 x 90 x 45 mm').key, '130x90x45');
  assert.equal(parseSize('12.5x20.75x3').key, '12.5x20.75x3');
  assert.equal(parseSize('700 ML').kind, 'other');
  assert.equal(parseSize(''), null);
  assert.equal(parseSize(null), null);
});

test('normStyle: stray spaces and case do not make a new pasting style', () => {
  assert.equal(normStyle('LOCK '), 'LOCK');
  assert.equal(normStyle('lOCK'), 'LOCK');
  assert.equal(normStyle('  dbl  pas '), 'DBL PAS');
  assert.equal(normStyle(''), null);
});

test('sizerProposals: the Sizer tab — blank length and width, two cartons a block', () => {
  const p = sizerProposals({ l: 100, w: 40, h: 80 });
  const one = p.find(x => x.l_ups === 1 && x.w_ups === 1);
  near(one.sheet_l, ((100 + 40) * 2 + 10) / 25.4);
  near(one.sheet_w, ((((40 / 2 + 10) + 80 + 40 + 12) * 2) - 40 - 12) / 25.4);
  assert.equal(one.ups, 2);
  assert.equal(p.find(x => x.l_ups === 2 && x.w_ups === 3).ups, 12);
  assert.deepEqual(sizerProposals({ l: 100, w: 40 }), []);
});

test('compareCostings: says how much the cost moved and which inputs moved it', () => {
  const thenIn = { ...JOB, board_rate: 80 };
  const nowIn = { ...JOB, board_rate: 100, qty: 6000 };
  const c = compareCostings({ inputs: nowIn, result: computeCosting(nowIn) }, { inputs: thenIn, result: computeCosting(thenIn) });
  assert.ok(c.delta > 0);
  near(c.delta_pct, c.delta / c.then * 100);
  const board = c.reasons.find(r => r.part === 'board');
  assert.match(board.text, /board rate ₹80 → ₹100/);
  assert.match(board.text, /quantity 12,000 → 6,000/);
  const dp = c.reasons.find(r => r.part === 'dp');
  assert.equal(dp, undefined, 'die & pasting per carton did not move, so it is not a reason');
  assert.equal(c.significant, Math.abs(c.delta_pct) >= 15);
});

test('compareCostings: no comparison when either side cannot be worked out', () => {
  assert.equal(compareCostings({ inputs: {}, result: computeCosting({}) }, { inputs: JOB, result: computeCosting(JOB) }), null);
});

// ── twins ──────────────────────────────────────────────────────────────
test('client twin gives the same answers as the server, field for field', () => {
  const cases = [
    JOB,
    { ...JOB, qty: 600, wastage: 100 },
    { ...JOB, coat_factor: '', emb_rate: '', misc_pct: '' },
    { ...JOB, target_price: 3.5 },
    { ...JOB, gsm: '' },
    { ...JOB, print_fixed: 2500 },
  ];
  for (const f of Object.keys(FORMULAS)) {
    for (const c of cases) assert.deepEqual(client.computeCosting(c, f), server.computeCosting(c, f));
  }
  for (const t of ['165X58X73R0', '100x140', '700 ML', '']) assert.deepEqual(client.parseSize(t), server.parseSize(t));
  assert.deepEqual(client.sizerProposals({ l: 120, w: 45, h: 60 }), server.sizerProposals({ l: 120, w: 45, h: 60 }));
  const a = { inputs: JOB, result: server.computeCosting(JOB) };
  const bIn = { ...JOB, gsm: 320, colours: 5 };
  const b = { inputs: bIn, result: server.computeCosting(bIn) };
  assert.deepEqual(client.compareCostings(b, a), server.compareCostings(b, a));
  assert.deepEqual(client.INPUTS, server.INPUTS);
  assert.deepEqual(client.STYLES, server.STYLES);
});

test('client twin is the server file word for word below its header', () => {
  return import('node:fs').then(fs => {
    const body = p => fs.readFileSync(new URL(p, import.meta.url), 'utf8').split('\nexport const CURRENT_FORMULA')[1];
    assert.equal(body('../../client/src/lib/costing.js'), body('./costing-engine.js'));
  });
});
