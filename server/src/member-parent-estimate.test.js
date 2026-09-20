// Before a run is locked, gangDetail's Board Position quotes memberParentSheets
// for every pending member. It counted cuts on the bare BOARD while the lock
// counted them on the parent on file — so CI-MRG-0028 read "Covered" at 3,550
// and the lock wrote 10,650. The estimate must be the lock's own arithmetic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { memberParentSheets, planLockParent, childFit, sheetsRequired, parentSheetsRequired } from './helpers.js';

// SW-544's lead member as MEMBER_VIEW carries it once the parent columns exist.
const MEMBER = { parent_sheets_required: null, sheets_required: null, ups: 2, wastage_pct: 0,
                 qty: 10100, fg_consumed_qty: 0, dispatched_qty: 0, wastage_sheets: 350,
                 sheet_l: 23, sheet_w: 38, child_l: 12.6, child_w: 23, parent_l: 22, parent_w: 28 };

test('the lead member\'s pre-lock estimate IS the lock\'s figure when a parent is on file', () => {
  const eff = { parent_l: 22, parent_w: 28, child_l: 12.6, child_w: 23, ups: 2 };
  const lock = parentSheetsRequired(sheetsRequired(eff, 10100, 350),
                                    childFit(planLockParent(eff, { sheet_l: 23, sheet_w: 38 }), eff).count);
  assert.equal(lock, 5400);
  assert.equal(memberParentSheets(MEMBER), lock);
});

test('no parent on file: the board\'s own sheet, as before (1,800)', () => {
  assert.equal(memberParentSheets({ ...MEMBER, parent_l: null, parent_w: null }), 1800);
});

test('a row without the parent columns (older callers) is unchanged', () => {
  const { parent_l, parent_w, ...older } = MEMBER;
  assert.equal(memberParentSheets(older), 1800);
});

const GANGS = readFileSync(new URL('./routes/gangs.js', import.meta.url), 'utf8');

test('MEMBER_VIEW carries the effective parent (job override, else master)', () => {
  const start = GANGS.indexOf('const MEMBER_VIEW = `');
  const VIEW = GANGS.slice(start, GANGS.indexOf('`;', start));
  assert.match(VIEW, /COALESCE\(\(ol\.spec_override->>'parent_l'\)::float, p\.parent_l\) AS parent_l/);
  assert.match(VIEW, /COALESCE\(\(ol\.spec_override->>'parent_w'\)::float, p\.parent_w\) AS parent_w/);
});

test('a co-printed run keeps its estimate on the board, as its lock does', () => {
  // Scoped to gangDetail — the plan route already has its own `coPrinted` line.
  const detail = GANGS.slice(GANGS.indexOf('export async function gangDetail'),
                             GANGS.indexOf('const mix = await gangMixContext(gang, withSheets'));
  assert.match(detail, /const coPrinted = gang\.kind !== 'merge' && gang\.layout_mode === 'shared';/);
  assert.match(detail, /memberParentSheets\(coPrinted \? \{ \.\.\.m, parent_l: null, parent_w: null \} : m\)/);
});
