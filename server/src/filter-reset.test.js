import { test } from 'node:test';
import assert from 'node:assert/strict';
// Client-only helper, tested here because this is where the repo runs its unit
// tests — same arrangement as customerCode / customerColour.
import { sameFilterValue, filtersDirty, dirtyFilterLabels, applyFilterReset }
  from '../../client/src/lib/filterReset.js';

test('sameFilterValue: the plain cases', () => {
  assert.ok(sameFilterValue('all', 'all'));
  assert.ok(sameFilterValue(false, false));
  assert.ok(!sameFilterValue('gang', 'all'));
  assert.ok(!sameFilterValue(true, false));
});

test('sameFilterValue: every spelling of "nothing chosen" agrees', () => {
  // Pages spell the empty filter differently — a Select hands back '', a chip
  // rail null. A page must not read dirty because of that.
  assert.ok(sameFilterValue('', null));
  assert.ok(sameFilterValue(null, undefined));
  assert.ok(sameFilterValue(undefined, ''));
  // But a real value is never "nothing".
  assert.ok(!sameFilterValue('short', ''));
  assert.ok(!sameFilterValue(0, ''), '0 is a real value, not an empty filter');
});

test('sameFilterValue: chip order is not part of the view', () => {
  // Lighting covered then short is the same set of rows as short then covered.
  assert.ok(sameFilterValue(['covered', 'short'], ['short', 'covered']));
  assert.ok(sameFilterValue([], []));
  assert.ok(!sameFilterValue(['covered'], []));
  assert.ok(!sameFilterValue(['covered'], ['covered', 'short']));
});

test('sameFilterValue: duplicates are not smuggled past the length check', () => {
  // Same length, same membership by naive test — but not the same multiset.
  assert.ok(!sameFilterValue(['a', 'a'], ['a', 'b']));
});

test('sameFilterValue: Sets compare by membership', () => {
  assert.ok(sameFilterValue(new Set([1, 2]), new Set([2, 1])));
  assert.ok(!sameFilterValue(new Set([1]), new Set([1, 2])));
  // A Set and an array are not interchangeable — that would hide a real bug.
  assert.ok(!sameFilterValue(new Set([1]), [1]));
});

test('sameFilterValue: a map of per-lane searches is empty until one is typed', () => {
  // Print Planning keeps every lane's own search as one object keyed by lane.
  // Typing then deleting leaves {triage: ''} behind, which still means "no
  // search" — a page must not read dirty because of a key with nothing in it.
  assert.ok(sameFilterValue({}, {}));
  assert.ok(sameFilterValue({ triage: '' }, {}));
  assert.ok(sameFilterValue({ triage: '', 'press-3': null }, {}));
  assert.ok(!sameFilterValue({ triage: 'swiss' }, {}));
  // Two lanes searching the same thing is still the same view.
  assert.ok(sameFilterValue({ a: 'x', b: '' }, { b: '', a: 'x' }));
  assert.ok(!sameFilterValue({ a: 'x' }, { a: 'y' }));
});

test('sameFilterValue: an object and an array are never interchangeable', () => {
  assert.ok(!sameFilterValue({}, []));
  assert.ok(!sameFilterValue([], {}));
});

test('filtersDirty: clean page, nothing to offer', () => {
  assert.equal(filtersDirty([
    ['', () => {}, ''],
    [[], () => {}, []],
    ['all', () => {}, 'all'],
    [false, () => {}, false],
  ]), false);
});

test('filtersDirty: any one axis off default is enough', () => {
  const clean = [['', () => {}, ''], [[], () => {}, []], ['all', () => {}, 'all']];
  assert.ok(filtersDirty([...clean, ['swiss', () => {}, '']]), 'a search counts');
  assert.ok(filtersDirty([...clean, [['covered'], () => {}, []]]), 'a chip counts');
  assert.ok(filtersDirty([...clean, ['gang', () => {}, 'all']]), 'a zone counts');
});

test('filtersDirty: a malformed entry never blanks the page', () => {
  // This runs during render on every filtered page in the ERP. A typo in one
  // page's list must degrade to "not dirty", not throw.
  assert.equal(filtersDirty(null), false);
  assert.equal(filtersDirty(undefined), false);
  assert.equal(filtersDirty([null, undefined, ['x'], 'nonsense']), false);
  assert.equal(filtersDirty([['on', () => {}, '']]), true, 'good entries still count');
});

test('dirtyFilterLabels: names only what is actually narrowing', () => {
  const labels = dirtyFilterLabels([
    ['swiss', () => {}, '', 'search'],
    [[], () => {}, [], 'board'],
    ['gang', () => {}, 'all', 'zone'],
    [[4], () => {}, [], 'customer'],
  ]);
  assert.deepEqual(labels, ['search', 'zone', 'customer']);
});

test('dirtyFilterLabels: an unlabelled axis is skipped, not rendered blank', () => {
  assert.deepEqual(dirtyFilterLabels([['swiss', () => {}, '']]), []);
});

test('applyFilterReset: every setter is called with its own default', () => {
  const got = {};
  applyFilterReset([
    ['swiss', v => { got.q = v; }, ''],
    [['covered'], v => { got.board = v; }, []],
    ['gang', v => { got.zone = v; }, 'all'],
    [true, v => { got.wip = v; }, false],
  ]);
  assert.equal(got.q, '');
  assert.deepEqual(got.board, []);
  assert.equal(got.zone, 'all');
  assert.equal(got.wip, false);
});

test('applyFilterReset: array defaults are copied, never shared', () => {
  // Two pages resetting must not end up holding one array. If they did, one
  // page pushing a chip would light it on the other.
  const seen = [];
  const dflt = [];
  applyFilterReset([[['x'], v => seen.push(v), dflt], [['y'], v => seen.push(v), dflt]]);
  assert.notEqual(seen[0], dflt, 'the default array itself must not be handed out');
  assert.notEqual(seen[0], seen[1], 'two axes must not share one array');
  seen[0].push('mutated');
  assert.deepEqual(dflt, [], 'mutating what a page got must not touch the default');
  assert.deepEqual(seen[1], []);
});

test('applyFilterReset: a Set default is copied too', () => {
  const dflt = new Set();
  let got = null;
  applyFilterReset([[new Set([1]), v => { got = v; }, dflt]]);
  assert.ok(got instanceof Set);
  assert.notEqual(got, dflt);
  assert.equal(got.size, 0);
});

test('applyFilterReset: survives a malformed list without throwing', () => {
  let called = 0;
  assert.doesNotThrow(() => applyFilterReset([
    null, ['v'], ['v', 'not-a-function', ''], ['v', () => { called++; }, ''],
  ]));
  assert.equal(called, 1);
  assert.doesNotThrow(() => applyFilterReset(null));
});

test('applyFilterReset: a clear() that ignores its argument still works', () => {
  // useKpiFilter exposes clear() with no parameter; it is handed in as the
  // setter so the KPI axis resets with everything else.
  let keys = ['ready'];
  const clear = () => { keys = []; };
  applyFilterReset([[keys, clear, []]]);
  assert.deepEqual(keys, []);
});
