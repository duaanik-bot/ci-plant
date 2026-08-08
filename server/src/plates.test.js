import test from 'node:test';
import assert from 'node:assert/strict';
import {
  artworkVersionOf,
  expandPlateQuantities,
  plateComponentsFromSpec,
  plateQuantityBreakdown,
  plateReadinessSummary,
  plateSizeOf,
  validatePlateDispositions,
} from './plates.js';
import { assertPlateReadyForPrinting } from './plate-lifecycle.js';

test('CMYK becomes four individual plate components', () => {
  assert.deepEqual(
    plateComponentsFromSpec({ colour_type: 'CMYK', colors: 4 }).map(row => row.component_label),
    ['Cyan', 'Magenta', 'Yellow', 'Black'],
  );
});

test('named Pantones retain their exact identity', () => {
  const rows = plateComponentsFromSpec({
    colour_type: 'CMYK + Pantone', cmyk_colours: 4, pantone_colours: 2,
    pantone_codes: '186 C; Reflex Blue C', colors: 6,
  });
  assert.equal(rows.length, 6);
  assert.deepEqual(rows.slice(4).map(row => row.component_label), [
    'Pantone - 186 C', 'Pantone - Reflex Blue C',
  ]);
});

test('Pantone-only jobs remain individually traceable when names are incomplete', () => {
  const rows = plateComponentsFromSpec({ colour_type: 'Pantone', pantone_colours: 2, pantone_codes: '485 C', colors: 2 });
  assert.deepEqual(rows.map(row => row.component_label), ['Pantone - 485 C', 'Pantone - Pantone 2']);
});

test('legacy total-only specs still generate the physical requirement', () => {
  assert.equal(plateComponentsFromSpec({ colors: 3 }).length, 3);
});

test('editable colour quantities expand to individually traceable physical plates', () => {
  const rows = expandPlateQuantities([
    { component_type: 'cyan', component_label: 'Anything', qty: 1 },
    { component_type: 'magenta', component_label: 'Anything', qty: 2 },
    { component_type: 'yellow', component_label: 'Anything', qty: 0 },
    { component_type: 'black', component_label: 'Anything', qty: 3 },
  ]);
  assert.equal(rows.length, 6);
  assert.deepEqual(rows.map(row => row.component_label), [
    'Cyan', 'Magenta', 'Magenta', 'Black', 'Black', 'Black',
  ]);
  assert.deepEqual(rows.map(row => row.sequence_no), [1, 2, 3, 4, 5, 6]);
});

test('Pantone quantities preserve identity while zero removes the component', () => {
  const rows = expandPlateQuantities([
    { component_type: 'pantone', component_label: 'Pantone - 186 C', pantone_code: '186 C', qty: 2 },
    { component_type: 'pantone', component_label: 'Pantone - Reflex Blue C', pantone_code: 'Reflex Blue C', qty: 0 },
  ]);
  assert.deepEqual(rows.map(row => row.component_label), ['Pantone - 186 C', 'Pantone - 186 C']);
  assert.deepEqual(rows.map(row => row.pantone_code), ['186 C', '186 C']);
});

test('quantity validation rejects fractions and an empty requirement', () => {
  assert.throws(() => expandPlateQuantities([{ component_type: 'cyan', qty: 1.5 }]), /whole number/);
  assert.throws(() => expandPlateQuantities([{ component_type: 'black', qty: 0 }]), /at least one plate/);
});

test('physical rows fold back into a colour and quantity breakdown', () => {
  const rows = plateQuantityBreakdown([
    { id: 1, component_type: 'black', component_label: 'Black', status: 'approved' },
    { id: 2, component_type: 'black', component_label: 'Black', status: 'approved' },
    { id: 3, component_type: 'pantone', component_label: 'Pantone - 186 C', pantone_code: '186 C', status: 'approved' },
  ]);
  assert.deepEqual(rows.map(row => [row.component_label, row.qty]), [['Black', 2], ['Pantone - 186 C', 1]]);
  assert.deepEqual(rows[0].component_ids, [1, 2]);
});

test('metallic plates use the controlled Pantone type with a named identity', () => {
  const rows = plateComponentsFromSpec({
    colour_type: 'CMYK', cmyk_colours: 4, metallic_colours: 1,
    metallic_details: 'Gold 871 C', colors: 5,
  });
  assert.equal(rows.at(-1).component_type, 'pantone');
  assert.equal(rows.at(-1).component_label, 'Metallic - Gold 871 C');
});

test('artwork version and plate size normalize stable matching keys', () => {
  assert.equal(artworkVersionOf({ party_artwork_code: ' AW-04 ' }), 'AW-04');
  assert.equal(artworkVersionOf({ output_number: 'OUT-91' }), 'OUT-91');
  assert.equal(plateSizeOf({ plate_size: '560 × 670' }), '560 x 670');
});

test('readiness is green only when every active component is ready', () => {
  assert.deepEqual(plateReadinessSummary([
    { status: 'verified_existing' }, { status: 'ordered' }, { status: 'cancelled' },
  ]), { required: 2, ready: 1, pending: 1, is_ready: false });
});

test('printing completion requires a disposition for every issued plate', () => {
  assert.throws(() => validatePlateDispositions([{ id: 1 }, { id: 2 }], [{ asset_id: 1, action: 'return' }]), /all 2 issued plates/);
  assert.equal(validatePlateDispositions([{ id: 1 }], [{ asset_id: 1, action: 'scrap' }])[0].action, 'scrap');
});

test('printing start is blocked when only part of a tracked plate set is ready', async () => {
  await assert.rejects(
    assertPlateReadyForPrinting(async () => [{ status: 'available' }, { status: 'approved' }], 91),
    /1 of 2 available/,
  );
});

test('legacy jobs without a Plate request remain startable', async () => {
  assert.deepEqual(await assertPlateReadyForPrinting(async () => [], 91), { required: 0, ready: 0, is_ready: true });
});
