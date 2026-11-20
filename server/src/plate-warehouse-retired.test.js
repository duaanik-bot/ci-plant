import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RETIRED_PLATE_STATUSES, retiredMode, splitRetiredSets } from './plate-retired.js';

// Retired plate sets (scrapped, lost, damaged) were 271 of 689 warehouse sets and
// 39% of /plates/warehouse (20 Nov 2026). The screen shows them only under
// "Set aside", so they are shipped only when that view asks: ?retired=hide answers
// { rows, retired_count }, ?retired=only the retired sets, no parameter the legacy
// array. Nothing is gone — one click away.

const sets = [
  { id: 1, status: 'available' },
  { id: 2, status: 'scrapped' },
  { id: 3, status: 'reserved' },
  { id: 4, status: 'lost' },
  { id: 5, status: 'returned_pending_verification' },
  { id: 6, status: 'damaged' },
  { id: 7, status: 'issued_to_printing' },
];

test('retired means scrapped, lost or damaged — nothing a press or a rack still holds', () => {
  assert.deepEqual([...RETIRED_PLATE_STATUSES].sort(), ['damaged', 'lost', 'scrapped']);
});

test('the mode parameter accepts hide and only; anything else is the legacy answer', () => {
  assert.equal(retiredMode('hide'), 'hide');
  assert.equal(retiredMode('only'), 'only');
  assert.equal(retiredMode(undefined), 'all');
  assert.equal(retiredMode('Hide'), 'all');
  assert.equal(retiredMode(['hide']), 'all');
});

test('no parameter is the identical array, same object', () => {
  assert.equal(splitRetiredSets(sets, 'all'), sets);
});

test('hide leaves no retired set and counts what it hid', () => {
  const out = splitRetiredSets(sets, 'hide');
  assert.deepEqual(out.rows.map(s => s.id), [1, 3, 5, 7]);
  assert.equal(out.retired_count, 3);
});

test('a plate waiting for verification stays in hide — it is not retired yet', () => {
  assert.ok(splitRetiredSets(sets, 'hide').rows.some(s => s.status === 'returned_pending_verification'));
});

test('only is the retired sets, in their original order', () => {
  assert.deepEqual(splitRetiredSets(sets, 'only').map(s => s.id), [2, 4, 6]);
});

test('hide and only split the legacy answer exactly, and the count is the only list', () => {
  const hide = splitRetiredSets(sets, 'hide');
  const only = splitRetiredSets(sets, 'only');
  assert.deepEqual([...hide.rows, ...only].map(s => s.id).sort(), sets.map(s => s.id).sort());
  assert.equal(hide.retired_count, only.length);
});

const root = new URL('../../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');

test('the warehouse route and the screen are wired to the split', () => {
  const route = read('server/src/routes/plates.js');
  const screen = read('client/src/components/PlatesLifecycle.jsx');
  assert.match(route, /import \{[^}]*splitRetiredSets[^}]*\} from '\.\.\/plate-retired\.js'/);
  assert.match(route, /splitRetiredSets\(groupPlateSets\(/);
  assert.match(route, /retiredMode\(req\.query\.retired\)/);
  assert.match(screen, /\/plates\/warehouse\?retired=hide/);
  assert.match(screen, /\/plates\/warehouse\?retired=only/);
  // The Set aside count is right before anyone opens the view.
  assert.match(screen, /key:'aside',label:'Set aside',count:asideCount/);
});
