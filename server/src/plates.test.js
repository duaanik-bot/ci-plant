import test from 'node:test';
import assert from 'node:assert/strict';
import {
  artworkVersionOf,
  defaultPlateSize,
  expandPlateQuantities,
  plateComponentsFromSpec,
  plateQuantityBreakdown,
  plateReadinessSummary,
  latestTimestamp,
  plateSizeOf,
  resolvePlateRate,
  validatePlateDispositions,
} from './plates.js';
import { applyPlateDispositions, assertPlateReadyForPrinting } from './plate-lifecycle.js';
import { TOOLING_REQUEST_STATUSES } from './tooling-requirements.js';

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

test('offset and metallic Plate PRs receive the requested default sizes', () => {
  assert.equal(defaultPlateSize({ colour_type: 'CMYK', print_process: 'Offset' }), '600 x 730');
  assert.equal(defaultPlateSize({ metallic_colours: 1, metallic_details: 'Gold 871 C' }), '560 x 670');
  assert.equal(defaultPlateSize({}, [{ component_label: 'Metallic - Silver' }]), '560 x 670');
});

test('plate rate resolves the vendor override before the base size rate', () => {
  const rates = [
    { id: 1, plate_master_id: 8, vendor_id: null, rate_per_plate: 200, effective_from: '2026-01-01', active: 1 },
    { id: 2, plate_master_id: 8, vendor_id: 23, rate_per_plate: 225, effective_from: '2026-07-01', active: 1 },
    { id: 3, plate_master_id: 8, vendor_id: 23, rate_per_plate: 250, effective_from: '2026-09-01', active: 1 },
  ];
  assert.equal(resolvePlateRate(rates, 8, 23, '2026-08-08').rate_per_plate, 225);
  assert.equal(resolvePlateRate(rates, 8, 99, '2026-08-08').rate_per_plate, 200);
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
  assert.throws(() => validatePlateDispositions([{ id: 1 }], [{ asset_id: 1, action: 'scrap' }]), /Return all 1 issued plates/);
  assert.equal(validatePlateDispositions([{ id: 1 }], [{ asset_id: 1, action: 'return' }])[0].action, 'return');
});

test('plate disposition validation treats an empty result as no issued plates', () => {
  assert.deepEqual(validatePlateDispositions(null, null), []);
});

test('the latest use across a set is the newest date, not the alphabetical one', () => {
  // Regression: db.js overrides only the numeric parsers, so a timestamptz arrives as
  // a JS Date. A bare .sort() stringifies its arguments, and Date.toString() begins
  // with the WEEKDAY — so the set's "last used" ranked Fri/Mon/Sat/Sun/Thu/Tue/Wed and
  // reported whichever plate fell latest in the alphabet.
  const dates = [
    new Date('2026-08-03T10:00:00Z'), // Monday
    new Date('2026-08-07T10:00:00Z'), // Friday — the real latest
    new Date('2026-08-05T10:00:00Z'), // Wednesday
  ];
  assert.equal(latestTimestamp(dates).toISOString(), '2026-08-07T10:00:00.000Z');
  assert.equal(latestTimestamp([]), null);
  assert.equal(latestTimestamp([null, undefined]), null);
});

test('returning plates never writes a status the tooling request cannot hold', async () => {
  // Regression: completion wrote 'returned_pending_verification' — a plate_assets and
  // plate_request_components state — onto tooling_requests, whose CHECK constraint has
  // no such member. Every printing completion carrying tracked plates died on a 23514,
  // and no test caught it because the suite never opens a database.
  const statements = [];
  const assets = [{ id: 1, component_label: 'Black', request_component_id: 11, tooling_request_id: 7, current_job_card_id: 3, condition: 'Good' }];
  const qc = async (sql, params = []) => {
    statements.push({ sql, params });
    return /FROM job_stages/.test(sql) ? assets : [];
  };
  await applyPlateDispositions(qc, qc, 55, [{ asset_id: 1, action: 'return' }], 'Tester');

  const written = statements
    .filter(s => /UPDATE tooling_requests SET status/.test(s.sql))
    .map(s => s.params[0]);
  assert.ok(written.length, 'the request status should still be advanced');
  for (const status of written) {
    assert.ok(TOOLING_REQUEST_STATUSES.includes(status),
      `"${status}" is not a tooling request status — the database will reject it`);
  }
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

// ── The plate gate must never stop the press silently, and never for ever ──
// Board is physics; a plate's rack paperwork is not. The press operator is the
// one person who can see whether the plates are in his hand, so the gate tells
// him what the ERP thinks is missing and lets him overrule it on the record.

test('the plate refusal names the components the press is short of', async () => {
  await assert.rejects(
    assertPlateReadyForPrinting(async () => [
      { status: 'available', component_label: 'Cyan', request_number: 'CI-TR-0021' },
      { status: 'po_created', component_label: 'Magenta', request_number: 'CI-TR-0021' },
      { status: 'pr_required', component_label: 'Black', request_number: 'CI-TR-0021' },
    ], 91),
    err => {
      assert.equal(err.status, 409);
      assert.equal(err.body.code, 'PLATES_NOT_READY');
      assert.deepEqual(err.body.plates.missing.map(m => m.component_label), ['Magenta', 'Black']);
      assert.deepEqual(err.body.plates.request_numbers, ['CI-TR-0021']);
      assert.match(err.message, /Magenta, Black/);
      return true;
    },
  );
});

test('an acknowledged plate shortfall starts the run and reports the override', async () => {
  const summary = await assertPlateReadyForPrinting(async () => [
    { status: 'available', component_label: 'Cyan' },
    { status: 'po_created', component_label: 'Magenta' },
  ], 91, true);
  assert.equal(summary.is_ready, false);
  assert.equal(summary.overridden, true);
  assert.deepEqual(summary.missing.map(m => m.component_label), ['Magenta']);
});

test('acknowledging changes nothing when the plates were ready anyway', async () => {
  const summary = await assertPlateReadyForPrinting(async () => [{ status: 'available' }], 91, true);
  assert.equal(summary.is_ready, true);
  assert.equal(summary.overridden, false);
});
