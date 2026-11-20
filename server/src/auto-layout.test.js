import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dieSheet, stockedPiece, pickLayout } from '../../client/src/lib/autoLayout.js';
import { sheetLadder } from '../../client/src/lib/sizing.js';
import { parseSize } from '../../client/src/lib/costing.js';
import { recommend, blankValue } from '../../client/src/lib/costingUi.js';

// The layout picker for a new costing (owner, 20 Nov 2026): an old Die Master die first, else the least board a carton
// among the Size Library and the size proposals, and never a cheaper reading than the enquiry gave. Every size, die and
// code here is invented.

const boards = [{ sheet_l: 23, sheet_w: 36 }];
const die = (o = {}) => ({ id: 1, code: '123', ups: 6, sheet_size: '17.5X22.5', condition: 'Good', ...o });
const lockSize = { kind: 'carton', l: 60, w: 40, h: 100 };

test('a usable Die Master die gives its ups on the smallest stocked piece', () => {
  const a = pickLayout({ style: 'LOCK', size: lockSize, dies: [die()], masterDie: '123', boards });
  assert.equal(a.kind, 'die');
  assert.equal(a.ups, 6);
  assert.equal(a.sheet_l, 18);
  assert.equal(a.sheet_w, 23);
  // both sheets short × long (M5): the die's sheet, then the stocked piece it is costed on
  assert.match(a.note, /^Die Master 123: 6 up; die sheet 17\.5×22\.5 → costed on 18×23$/);
  const b = pickLayout({ style: 'LOCK', size: lockSize, dies: [die({ ups: 8, sheet_size: '14X21' })], masterDie: '123', boards: [{ sheet_l: 22, sheet_w: 28 }] });
  assert.equal(b.kind, 'die');
  assert.deepEqual([b.sheet_l, b.sheet_w], [14, 22]);
});

test('a Scrapped die is not used', () => {
  const d = die({ condition: 'Scrapped' });
  const r = pickLayout({ style: 'LOCK', size: lockSize, dies: [d], masterDie: d.code, boards });
  assert.notEqual(r.kind, 'die');
  assert.notEqual(pickLayout({ style: 'LOCK', size: lockSize, dies: [d], masterDie: null, boards }).kind, 'die');
});

test('dieSheet reads mm and gives up on junk; an oversize die sheet is kept and flagged', () => {
  assert.deepEqual(dieSheet('17.5X22.5'), { long: 22.5, short: 17.5 });
  assert.deepEqual(dieSheet('15.75 x 20.75'), { long: 20.75, short: 15.75 });
  assert.deepEqual(dieSheet('760 x 1020'), { long: 40.16, short: 29.92 });
  assert.equal(dieSheet('N/A'), null);
  assert.equal(dieSheet(null), null);
  assert.equal(dieSheet('17.5 x 700'), null);
  const r = pickLayout({ style: 'LOCK', size: lockSize, dies: [die({ sheet_size: '19X28.8' })], masterDie: '123', boards });
  assert.equal(r.kind, 'die');
  assert.deepEqual([r.sheet_l, r.sheet_w], [19, 28.8]);
  assert.ok(r.flags.some(f => f.includes('bigger than every stocked piece')));
});

test('stockedPiece is the smallest ladder piece that holds the sheet', () => {
  const ladder = sheetLadder(boards);
  assert.deepEqual(stockedPiece({ long: 22.5, short: 17.5 }, ladder), { long: 23, short: 18 });
  assert.equal(stockedPiece({ long: 40, short: 30 }, ladder), null);
});

test('a die with no readable sheet falls back to a layout with the same ups', () => {
  const noSheet = die({ sheet_size: 'N/A' });
  const lib = { id: 5, sheet_l: 18, sheet_w: 23, ups: 6, style: 'LOCK', times_costed: 2 };
  assert.equal(pickLayout({ style: 'LOCK', size: lockSize, library: [lib], dies: [noSheet], masterDie: '123', boards }).kind, 'library');
  const p = pickLayout({ style: 'LOCK', size: lockSize, dies: [noSheet], masterDie: '123', boards });
  assert.equal(p.kind, 'proposal');
  assert.equal(p.ups, 6);
  assert.deepEqual(pickLayout({ style: 'LOCK', size: lockSize, dies: [die({ sheet_size: 'N/A', ups: 11 })], masterDie: '123', boards }).none, true);
});

test('a die with no readable sheet prefers the library entry with its ups even when a proposal is smaller', () => {
  const big = { id: 9, sheet_l: 20, sheet_w: 28, ups: 6, style: 'LOCK', times_costed: 1 }; // 93 sq in a carton; the proposal is 69
  const r = pickLayout({ style: 'LOCK', size: lockSize, library: [big], dies: [die({ sheet_size: 'N/A' })], masterDie: '123', boards });
  assert.equal(r.kind, 'library');
  assert.deepEqual([r.sheet_l, r.sheet_w, r.ups], [20, 28, 6]);
});

test('least board wins; a Size Library layout wins a tie', () => {
  const tie = { id: 7, sheet_l: 18, sheet_w: 23, ups: 6, style: 'LOCK', times_costed: 4 };
  const a = pickLayout({ style: 'LOCK', size: lockSize, library: [tie], boards });
  assert.equal(a.kind, 'library');
  assert.deepEqual([a.sheet_l, a.sheet_w, a.ups], [18, 23, 6]);
  assert.equal(a.note, 'least board a carton: 18 × 23 in, 6 up (Size Library, used 4×)');
  const worse = { ...tie, ups: 4 };
  const b = pickLayout({ style: 'LOCK', size: lockSize, library: [worse], boards });
  assert.equal(b.kind, 'proposal');
  assert.deepEqual([b.sheet_l, b.sheet_w, b.ups], [18, 23, 6]);
  assert.match(b.note, /^least board a carton: 23 × 18 in, 6 up \(Lock bottom, tuck top\)$/);
  const other = pickLayout({ style: 'LOCK', size: lockSize, library: [{ ...tie, style: 'SIDE' }], boards });
  assert.equal(other.kind, 'proposal');
});

test('a side-pasted carton is drawn only in the reading the enquiry gives', () => {
  const size = { kind: 'carton', l: 50, w: 30, h: 120 }; // top-open fits 6 up on 23 × 18, side-open only 5
  const side = pickLayout({ style: 'SIDE', size, opening: 'side', boards });
  assert.equal(side.ups, 5);
  assert.deepEqual(side.flags, []);
  const none = pickLayout({ style: 'SIDE', size, boards });
  assert.equal(none.ups, 5);
  assert.deepEqual(none.flags, ['opening assumed: side-open']);
  const top = pickLayout({ style: 'SIDE', size, opening: 'top', boards });
  assert.equal(top.ups, 6);
});

// Final review M3 (the plan's Review Focus 5): a Die Master sheet that cannot be read is said so on the costing.
test("an unreadable Die Master sheet is flagged, and the layout is chosen by least board", () => {
  for (const sheet_size of ['N/A', '18 x 23 in', '17.5 x 700']) {
    const r = pickLayout({ style: 'LOCK', size: lockSize, dies: [die({ sheet_size })], masterDie: '123', boards });
    assert.equal(r.kind, 'proposal', sheet_size);
    assert.equal(r.ups, 6, sheet_size);
    assert.deepEqual(r.flags, [`Die Master 123: sheet '${sheet_size}' unreadable — layout chosen by least board`], sheet_size);
  }
  // a die with no sheet written at all has nothing unreadable to say
  assert.deepEqual(pickLayout({ style: 'LOCK', size: lockSize, dies: [die({ sheet_size: null })], masterDie: '123', boards }).flags, []);
  assert.deepEqual(pickLayout({ style: 'LOCK', size: lockSize, dies: [die({ sheet_size: '  ' })], masterDie: '123', boards }).flags, []);
});

// Final review I3: a flat size (a leaflet, a die-cut card) has no depth; it still takes the layouts the Size Library has
// for it. The depth is needed only to draw a side- or lock-pasted carton.
test('a flat size takes its Size Library layout: the depth is needed only to draw a carton', () => {
  const flat = parseSize('150x210');
  assert.equal(flat.h, null);
  const lib = [{ id: 1, sheet_l: 20, sheet_w: 30, ups: 4, style: 'LIT', times_costed: 7 }];
  const a = pickLayout({ style: 'LIT', size: flat, library: lib, boards });
  assert.deepEqual([a.kind, a.sheet_l, a.sheet_w, a.ups], ['library', 20, 30, 4]);
  assert.equal(a.note, 'least board a carton: 20 × 30 in, 4 up (Size Library, used 7×)');
  // the least board among its entries, as for a carton
  const two = pickLayout({ style: 'LIT', size: flat, library: [...lib, { id: 2, sheet_l: 18, sheet_w: 24, ups: 4, style: 'LIT', times_costed: 1 }], boards });
  assert.deepEqual([two.sheet_l, two.sheet_w, two.ups], [18, 24, 4]);
  // a side-pasted entry of a flat size: no reading is drawn, so no opening is assumed
  const side = pickLayout({ style: 'SIDE', size: flat, library: [{ ...lib[0], style: 'SIDE' }], boards });
  assert.deepEqual([side.kind, side.flags], ['library', []]);
  // nothing in the library: a drawn style still needs the depth; an undrawn one says so
  assert.deepEqual(pickLayout({ style: 'LOCK', size: flat, boards }), { none: true, why: 'needs a size' });
  assert.deepEqual(pickLayout({ style: 'LIT', size: flat, boards }), { none: true, why: 'LIT cartons are not drawn — type the sheet and ups' });
  assert.deepEqual(pickLayout({ style: 'LIT', size: parseSize('150'), library: lib, boards }), { none: true, why: 'needs a size' });
  // the form, given the stocked sheets as CostingEditor gives them, fills the same layout
  const v = recommend({ ...blankValue({}), size_text: '150x210', style: 'LIT', sources: { style: { kind: 'manual' } } },
    { check: { library: { exact: lib }, history: [] }, boards });
  assert.deepEqual([v.inputs.sheet_l, v.inputs.sheet_w, v.inputs.ups], [20, 30, 4]);
  assert.equal(v.sources.ups.kind, 'library');
});

test('no pasting, no size, an undrawn style: no layout, with the reason', () => {
  assert.deepEqual(pickLayout({ style: null, size: lockSize, boards }), { none: true, why: 'needs pasting: side or lock?' });
  assert.deepEqual(pickLayout({ style: 'LOCK', size: null, boards }), { none: true, why: 'needs a size' });
  assert.deepEqual(pickLayout({ style: 'Tray', size: lockSize, boards }), { none: true, why: 'Tray cartons are not drawn — type the sheet and ups' });
  const lib = { id: 1, sheet_l: 18, sheet_w: 23, ups: 6, style: 'Tray', times_costed: 1 };
  assert.equal(pickLayout({ style: 'Tray', size: lockSize, library: [lib], boards }).kind, 'library');
});
