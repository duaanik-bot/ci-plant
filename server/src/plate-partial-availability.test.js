// "Fully or partially available" — how many of a job's plates are on the rack.
//
// The STATE already answers can-it-print (green only when every plate is in
// hand). What it could not answer is how close a red job is: one plate missing
// of four and four missing of four are the same colour, because they are the
// same fact to a press — it cannot run. But they are completely different facts
// to whoever is chasing them, and that is what the count is for.
//
// DELIBERATELY NOT A FOURTH COLOUR. PlateStatus.jsx's own rule is that both
// troubled states are RED because amber would let one read as a third, milder
// kind of fine. Three plates of four cannot go on a press, so a "partly ready"
// amber would say "nearly fine" about a job that is exactly as stopped as one
// with no plates at all. The count qualifies the state; it never softens it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { plateStateOf, plateCountsOf } from './helpers.js';

const c = (status, n = 1) => Array.from({ length: n }, () => ({ status }));

test('every plate on the rack is fully available', () => {
  const set = [...c('available', 2), ...c('reserved'), ...c('issued')];
  assert.deepEqual(plateCountsOf(set), { have: 4, need: 4 });
  assert.equal(plateStateOf(set), 'ready');
});

test('some on the rack and some still coming is PARTIAL, and still not ready', () => {
  const set = [...c('available', 3), ...c('po_created')];
  assert.deepEqual(plateCountsOf(set), { have: 3, need: 4 });
  assert.equal(plateStateOf(set), 'on_order',
    'three of four cannot print — the count must not promote the state to ready');
});

test('nothing on the rack is zero of four, not an absent count', () => {
  const set = c('pr_required', 4);
  assert.deepEqual(plateCountsOf(set), { have: 0, need: 4 });
  assert.equal(plateStateOf(set), 'none');
});

test('a cancelled plate is not owed and is not counted either way', () => {
  const set = [...c('available', 2), ...c('cancelled', 5)];
  assert.deepEqual(plateCountsOf(set), { have: 2, need: 2 },
    'a cancelled component must leave the denominator too, or a fully covered job reads 2/7 for ever');
  assert.equal(plateStateOf(set), 'ready');
});

test('no requirement at all has nothing to count', () => {
  assert.equal(plateCountsOf([]), null);
  assert.equal(plateCountsOf(null), null);
  assert.equal(plateStateOf([]), null, 'twin of plateStateOf: not asked yet, not a shortage');
});

test('have never exceeds need', () => {
  for (const n of [1, 3, 9]) {
    const { have, need } = plateCountsOf(c('issued', n));
    assert.ok(have <= need, `${have}/${need} claims more plates in hand than the job owes`);
  }
});
