import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readCostingRow, readSizeChartRow, buildSizeLibrary, possibleDuplicates, sheetDate, sizeEntryKey } from './costing-sheet.js';
import { computeCosting } from './costing-engine.js';

// Rows are invented, shaped like the cost sheet's. `cells` maps column → value, or [value, formula].
const getter = cells => col => {
  const c = cells[col];
  if (c === undefined) return { v: undefined, f: undefined };
  return Array.isArray(c) ? { v: c[0], f: c[1] } : { v: c, f: undefined };
};

const inputs = { qty: 8000, sheet_l: 18, sheet_w: 24, ups: 8, gsm: 300, board_rate: 95, wastage: 250, print_rate: 420, colours: 4, process: 1500, coat_factor: 3, emb_rate: 0.12, dp_rate: 0.22, pf_pct: 5, misc_pct: 0 };
const ROW = 2000;
function sheetRow(over = {}) {
  const r = computeCosting({ ...inputs, print_min: 1600 }, 'CI-1');
  return {
    B: 'TESTCO', C: new Date(2025, 2, 14), D: 'Test Tablets 10x10', E: '120x40x90', F: ['LOCK ', `IFERROR(VLOOKUP(E${ROW},'Size chart '!B:F,5,0),"")`],
    G: 8000, M: [18, `IFERROR(VLOOKUP($E${ROW},'Size chart '!$B:$E,2,0),"")`], N: [24, 'VLOOKUP'], O: [8, 'VLOOKUP'],
    P: 300, Q: 95, R: 250, S: 420, T: 4, U: 1500, V: 3, W: 0.12, X: 0.22, Y: [0.05, `IF(E${ROW}=ISBLANK(FALSE),"",Y${ROW - 1})`],
    AB: [r.parts.board, 'x'], AD: [r.parts.print, `IFERROR(IF(S${ROW}*T${ROW}*AA${ROW}/1000>1600,S${ROW}*T${ROW}*AA${ROW}/1000,"1600"),"")`],
    AE: [r.parts.coat, 'x'], AF: [r.parts.dp, `IF(X${ROW}*G${ROW}=0,"",X${ROW}*G${ROW})`], AG: [1500, `IF(U${ROW}=0,"",U${ROW})`],
    AL: [r.cost_per_unit, `IFERROR(AK${ROW}/G${ROW}+W${ROW},"")`], AM: [r.cost_per_unit + 0.05, `IFERROR(AL${ROW}+0.05,"")`],
    AN: [r.cost_value, 'x'],
    ...over,
  };
}

test('readCostingRow: a current-era row reads to the CI-1 formula and reproduces the sheet', () => {
  const c = readCostingRow(getter(sheetRow()), ROW);
  assert.equal(c.formula, 'CI-1');
  assert.equal(c.inputs.print_min, 1600);
  assert.equal(c.inputs.pf_pct, 5);
  assert.equal(c.inputs.margin, 0.05);
  assert.equal(c.style, 'LOCK');
  assert.equal(c.size.key, '120x40x90');
  assert.equal(c.date, '2025-03-14');
  assert.equal(c.reproduced, true);
  assert.deepEqual(c.notes, []);
});

test('readCostingRow: the formula version comes from the row\'s own formulas', () => {
  const b = readCostingRow(getter(sheetRow({ AD: [3360, `S${ROW}*T${ROW}*AA${ROW}/1000`] })), ROW);
  assert.equal(b.formula, 'SHEET-B');
  const a = readCostingRow(getter(sheetRow({ AD: [3360, 'x'], AL: [1, `AK${ROW}/G${ROW}`] })), ROW);
  assert.equal(a.formula, 'SHEET-A');
});

test('readCostingRow: a die & pasting rate the sheet never charged is recorded, and the row still reproduces', () => {
  const base = computeCosting({ ...inputs, dp_rate: 0, print_min: 1600 }, 'CI-1');
  const c = readCostingRow(getter(sheetRow({ AF: undefined, AL: [base.cost_per_unit, `IFERROR(AK${ROW}/G${ROW}+W${ROW},"")`] })), ROW);
  assert.equal(c.inputs.dp_rate, 0);
  assert.equal(c.inputs.dp_rate_typed, 0.22);
  assert.ok(c.notes.some(n => n.kind === 'dp_not_charged'));
  assert.equal(c.reproduced, true);
});

test('readCostingRow: a row that breaks its own rule is kept, not reproduced, with the part named', () => {
  const c = readCostingRow(getter(sheetRow({ AB: [99, 'x'], AL: [9.99, `IFERROR(AK${ROW}/G${ROW}+W${ROW},"")`] })), ROW);
  assert.equal(c.reproduced, false);
  assert.equal(c.sheet_result.cost_per_unit, 9.99);
  assert.ok(c.notes.some(n => n.kind === 'part_differs' && /^Board/.test(n.text)));
});

test('readCostingRow: a number in the Party column is not a customer', () => {
  const c = readCostingRow(getter(sheetRow({ B: 400 })), ROW);
  assert.equal(c.party, null);
  assert.ok(c.notes.some(n => n.kind === 'party_is_number'));
});

test('readCostingRow: an empty row is skipped', () => {
  assert.equal(readCostingRow(getter({}), ROW), null);
});

test('sheetDate: Dates read by local parts, and the sheet\'s typed DD-MM-YY text', () => {
  assert.equal(sheetDate(new Date(2025, 11, 30)), '2025-12-30');
  assert.equal(sheetDate('30-12-2025'), '2025-12-30');
  assert.equal(sheetDate('31-10-25'), '2025-10-31');
  assert.equal(sheetDate('27-1-2026'), '2026-01-27');
  assert.equal(sheetDate('2026'), null);
  assert.equal(sheetDate(null), null);
});

test('buildSizeLibrary: rows agreeing on size, pasting and layout are one entry; any difference keeps them apart', () => {
  const chart = [
    readSizeChartRow(getter({ B: '120X40X90', C: 18, D: 24, E: 8, F: 'LOCK ' }), 2),
    readSizeChartRow(getter({ B: '120x40x90', C: 18, D: 24, E: 8, F: 'lock' }), 3),
    readSizeChartRow(getter({ B: '120x40x90', C: 15, D: 25, E: 6, F: 'LOCK' }), 4),
    readSizeChartRow(getter({ B: '120x40x90', C: 18, D: 24, E: 8, F: 'SIDE' }), 5),
    readSizeChartRow(getter({ B: '40x120x90', C: 18, D: 24, E: 8, F: 'SIDE' }), 6),
  ];
  const lib = buildSizeLibrary(chart, []);
  assert.equal(lib.length, 4);
  const merged = lib.find(e => e.key === sizeEntryKey('120x40x90', 'LOCK', 18, 24, 8));
  assert.deepEqual(merged.refs.map(r => r.row), [2, 3]);
  const dups = possibleDuplicates(lib);
  assert.deepEqual(dups.map(d => d.kind).sort(), ['order', 'style']);
});

test('buildSizeLibrary: a size costed with a layout the chart lacks is added from the costing', () => {
  const chart = [readSizeChartRow(getter({ B: '120X40X90', C: 18, D: 24, E: 8, F: 'LOCK' }), 2)];
  const costed = readCostingRow(getter(sheetRow({ M: 19, N: 25, O: 8 })), ROW);
  const lib = buildSizeLibrary(chart, [costed]);
  assert.equal(lib.length, 2);
  assert.equal(lib[1].source, 'costing');
  assert.equal(lib[1].refs[0].row, ROW);
});
