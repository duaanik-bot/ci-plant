// A gang with no plate requirement must not read "Plates OK".
//
// THE BUG, seen on CI-GANG-0009: a solid green tick on a run whose plates are
// not in the warehouse and were never even asked for.
//
// `null` is load-bearing in this module — it means "not asked yet" and renders
// NOTHING, deliberately distinct from 'none' (a real, unmet requirement painted
// solid red). stampPlateState is careful to produce it. The gang collapse then
// threw it away: worstPlateState had a case for 'none' and 'on_order' and fell
// through to 'ready' for everything else, so a run of members that each had
// null collapsed to 'ready' — the strongest possible claim built out of no
// information at all.
//
// It read as a pale tint before and was easy to miss; the moment the ready
// state became a solid green fill it was the loudest thing on the row.
import test from 'node:test';
import assert from 'node:assert/strict';
import { worstPlateState } from './helpers.js';

test('a run nobody has asked plates for stays UNKNOWN, never ready', () => {
  assert.equal(worstPlateState([null, null]), null,
    'two members with no plate requirement is not evidence that the plates are in hand');
  assert.equal(worstPlateState([]), null,
    'an empty set is no information — `every` on an empty array is true, which is exactly '
    + 'how "no plates asked for" became "all plates present"');
  assert.equal(worstPlateState(), null);
});

test('a member that DOES know still decides for the run', () => {
  // A run goes on press as one job: one member short stops all of them, and a
  // member with no requirement must not dilute a member that has one.
  assert.equal(worstPlateState([null, 'none']), 'none');
  assert.equal(worstPlateState([null, 'on_order']), 'on_order');
  assert.equal(worstPlateState(['ready', null]), 'ready');
  assert.equal(worstPlateState(['ready', 'none']), 'none');
  assert.equal(worstPlateState(['ready', 'on_order']), 'on_order');
  assert.equal(worstPlateState(['ready', 'ready']), 'ready');
});

test('ready is only ever claimed from a member that actually reported it', () => {
  // The property the bug violated: 'ready' out means 'ready' went in.
  for (const set of [[null], [null, null], [], [undefined, null]]) {
    assert.notEqual(worstPlateState(set), 'ready',
      `worstPlateState(${JSON.stringify(set)}) claims the plates are in hand with nothing to support it`);
  }
});
