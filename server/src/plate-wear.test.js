// Plate wear — is the plate serving this colour brand new or has it already run,
// and is any of them due for replacement.
//
// The plant's vocabulary already exists (MANUAL_PLATE_RACKS: Fresh — never
// printed, Used — has already run); this is the same two words asked of a
// REQUIREMENT, whose row is a set of four or five plates rather than one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { componentPlate, plateWearSummary, plateWearRemark, PLATE_REPLACE_CONDITIONS } from './plates.js';

const c = (label, over = {}) => ({
  component_type: label.toLowerCase(), component_label: label, status: 'available', ...over,
});
// A colour served by a plate the job has actually taken.
const matched = (label, runs, condition = 'Good', over = {}) => c(label, {
  matched_asset_id: 1, matched_asset_number: `PL-${label}`, matched_use_count: runs,
  matched_condition: condition, ...over,
});
// A colour the rack merely OFFERS — nobody has taken it yet.
const proposed = (label, runs, condition = 'Good') => c(label, {
  proposed_asset_id: 2, proposed_asset_number: `RK-${label}`, proposed_use_count: runs,
  proposed_condition: condition,
});

test('the matched plate wins over the proposed one — it is the plate the job holds', () => {
  const plate = componentPlate(matched('Cyan', 4, 'Fair', {
    proposed_asset_id: 9, proposed_asset_number: 'RK-Cyan', proposed_use_count: 0, proposed_condition: 'Good',
  }));
  assert.equal(plate.asset_number, 'PL-Cyan');
  assert.equal(plate.runs, 4);
  assert.equal(plate.condition, 'Fair');
  assert.equal(plate.source, 'matched');
});

test('with no matched plate the rack candidate is what the row is about to spend', () => {
  const plate = componentPlate(proposed('Magenta', 3));
  assert.equal(plate.asset_number, 'RK-Magenta');
  assert.equal(plate.runs, 3);
  assert.equal(plate.source, 'proposed');
});

test('a colour with no plate either side is null — a plate to be bought is not a plate yet', () => {
  assert.equal(componentPlate(c('Yellow')), null);
});

test('use_count is NOT NULL DEFAULT 0, so a missing count means never run', () => {
  assert.equal(componentPlate(matched('Black', null)).runs, 0);
  assert.equal(componentPlate(matched('Black', undefined)).runs, 0);
});

test('a set is Fresh only when EVERY plate in it is brand new', () => {
  const summary = plateWearSummary([matched('Cyan', 0), matched('Magenta', 0), matched('Yellow', 0)]);
  assert.equal(summary.wear, 'fresh');
  assert.equal(summary.fresh, 3);
  assert.equal(summary.used, 0);
});

test('one plate that has run makes the whole set Used — the row carries the wear risk', () => {
  const summary = plateWearSummary([matched('Cyan', 0), matched('Magenta', 0), matched('Yellow', 1)]);
  assert.equal(summary.wear, 'used', 'three fresh and one used is a used set, not a fresh one');
  assert.equal(summary.fresh, 2);
  assert.equal(summary.used, 1);
  assert.equal(summary.max_runs, 1);
});

test('a requirement with no plates at all reports nothing, rather than a fresh set', () => {
  assert.equal(plateWearSummary([c('Cyan'), c('Magenta')]), null,
    'plates still to be bought must not read as brand new plates in hand');
  assert.equal(plateWearSummary([]), null);
  assert.equal(plateWearSummary(null), null);
});

test('cancelled colours leave the set — they are not owed and not held', () => {
  const summary = plateWearSummary([matched('Cyan', 0), matched('Magenta', 7, 'Good', { status: 'cancelled' })]);
  assert.equal(summary.wear, 'fresh', 'a cancelled used plate cannot make the live set look worn');
  assert.equal(summary.plates, 1);
});

test('replacement is decided by CONDITION alone — a run count is a fact, never a verdict', () => {
  const worn = plateWearSummary([matched('Cyan', 99), matched('Magenta', 40)]);
  assert.deepEqual(worn.replace, [], '99 runs in Good condition is not a reason to replace');
  const damaged = plateWearSummary([matched('Cyan', 1, 'Damaged'), matched('Magenta', 1)]);
  assert.equal(damaged.replace.length, 1);
  assert.equal(damaged.replace[0].component_label, 'Cyan');
  assert.equal(damaged.replace[0].condition, 'Damaged');
});

test('every condition that is not Good calls for a replacement', () => {
  for (const condition of ['Fair', 'Damaged', 'Scrapped', 'Lost']) {
    assert.ok(PLATE_REPLACE_CONDITIONS.has(condition), `${condition} must be replaceable`);
    assert.equal(plateWearSummary([matched('Cyan', 1, condition)]).replace.length, 1);
  }
  assert.equal(plateWearSummary([matched('Cyan', 1, 'Good')]).replace.length, 0);
});

test('each colour is reported on its own, so C M Y K + Pantone can be read apart', () => {
  const summary = plateWearSummary([
    matched('Cyan', 2), matched('Magenta', 9), matched('Black', 0, 'Fair'),
  ]);
  assert.deepEqual(summary.components.map(row => [row.component_label, row.runs, row.wear]), [
    ['Cyan', 2, 'used'], ['Magenta', 9, 'used'], ['Black', 0, 'fresh'],
  ]);
  assert.equal(summary.components[2].replace, true, 'a fresh plate in Fair condition still needs replacing');
});

test('the remark names the plate to replace, and says so plainly when none is due', () => {
  assert.match(plateWearRemark(plateWearSummary([matched('Cyan', 1, 'Damaged'), matched('Magenta', 1)])),
    /Replace Cyan/);
  assert.match(plateWearRemark(plateWearSummary([matched('Cyan', 0), matched('Magenta', 0)])),
    /Fresh set/);
  assert.match(plateWearRemark(plateWearSummary([matched('Cyan', 1), matched('Magenta', 1)])),
    /none due/i);
  assert.equal(plateWearRemark(null), '');
});

test('the remark points at the most-run plate only when the runs actually differ', () => {
  assert.match(plateWearRemark(plateWearSummary([matched('Cyan', 2), matched('Magenta', 9)])),
    /Magenta/, 'an uneven set should name where the wear is concentrated');
  assert.doesNotMatch(plateWearRemark(plateWearSummary([matched('Cyan', 1), matched('Magenta', 1)])),
    /most run/i, 'a set that has all run the same number of times has no standout to name');
});
