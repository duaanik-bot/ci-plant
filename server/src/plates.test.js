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
  issuedPlateSummary,
  plateRackSummary,
  PLATE_RETURN_QUEUE,
  plateReturnSetKey,
  validatePlateReplacementRequest,
  pickAvailableRackPlates,
  validateReturnVerification,
} from './plates.js';
import { applyPlateDispositions, plateReadinessForPrinting } from './plate-lifecycle.js';
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

test('printing completion moves the plates it was told about, and only those', () => {
  // It used to demand an account for every issued plate and refuse the completion
  // without one. A press that has finished its run has finished it; a locked
  // Complete button only means the COUNT goes unrecorded too. So absence is now
  // silence, not an error.
  const decided = validatePlateDispositions([{ id: 1 }, { id: 2 }], [{ asset_id: 1, action: 'return' }]);
  assert.deepEqual(decided.map(row => row.asset.id), [1]);
  // Return, scrap and lost are the three accounts a press can give — scrap became a
  // valid one when unticking a plate started retiring it. Anything else is a caller
  // bug, and it reads as no account at all rather than moving the plate somewhere
  // nobody asked for.
  assert.deepEqual(validatePlateDispositions([{ id: 1 }], [{ asset_id: 1, action: 'reissue' }]), []);
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

// ── The plate gate was REMOVED, not loosened ───────────────────────────────
// It used to throw a 409 (PLATES_NOT_READY) that the press could acknowledge
// past. Board is physics; a plate's rack paperwork is not — the plates can be in
// the operator's hand while this table still says 'po_created' — so what stood
// here as a refusal-with-an-override is now a report. The rule that replaced it
// lives in plates-never-block.test.js; these two hold the shape of the report.

test('a partly-ready plate set is reported, and the press starts anyway', async () => {
  const verdict = await plateReadinessForPrinting(
    async () => [{ status: 'available' }, { status: 'approved' }], 91);
  assert.equal(verdict.is_ready, false);
  assert.equal(verdict.ready, 1);
  assert.equal(verdict.required, 2);
});

test('legacy jobs without a Plate request read clean rather than short', async () => {
  const verdict = await plateReadinessForPrinting(async () => [], 91);
  assert.equal(verdict.is_ready, true);
  assert.equal(verdict.required, 0);
  assert.deepEqual(verdict.missing, []);
});

test('the report names the components the press is short of', async () => {
  // "Magenta, Black" tells an operator where to go; "1 of 3 available" does not.
  const verdict = await plateReadinessForPrinting(async () => [
    { status: 'available', component_label: 'Cyan', request_number: 'CI-TR-0021' },
    { status: 'po_created', component_label: 'Magenta', request_number: 'CI-TR-0021' },
    { status: 'pr_required', component_label: 'Black', request_number: 'CI-TR-0021' },
  ], 91);
  assert.deepEqual(verdict.missing.map(m => m.component_label), ['Magenta', 'Black']);
  assert.deepEqual(verdict.request_numbers, ['CI-TR-0021']);
});
test('a rack summarises as plate count, average age and a size split', () => {
  const today = new Date('2026-08-10T00:00:00Z');
  const sets = [
    { plate_size: '560 x 670', components: [
      { id: 1, plate_created_on: '2026-08-08' },   // 2 days
    ] },
    { plate_size: '600 x 730', components: [
      { id: 2, plate_created_on: '2026-07-31' },   // 10 days
      { id: 3, plate_created_on: '2026-08-04' },   // 6 days
      { id: 4, plate_created_on: null },           // unknown age — counted, not averaged
    ] },
  ];
  const summary = plateRackSummary(sets, today);
  assert.equal(summary.total, 4, 'counts physical plates, not sets');
  assert.equal(summary.avg_age_days, 6, '(2 + 10 + 6) / 3 — the undated plate cannot skew it');
  // 600 x 730 leads: it is the plant's main size and the one to read first.
  assert.deepEqual(summary.by_size.map(row => [row.plate_size, row.plates]), [
    ['600 x 730', 3], ['560 x 670', 1],
  ]);
});

test('a rack also averages WEAR, which is a different question from shelf age', () => {
  const today = new Date('2026-08-10T00:00:00Z');
  const sets = [
    // Same day on the shelf, wildly different lives: age alone cannot tell these
    // apart, which is the whole reason the card carries both figures.
    { plate_size: '600 x 730', components: [
      { id: 1, plate_created_on: '2026-08-05', use_count: 11 },
      { id: 2, plate_created_on: '2026-08-05', use_count: 0 },
    ] },
    { plate_size: '560 x 670', components: [
      { id: 3, plate_created_on: '2026-08-05', use_count: 1 },
    ] },
  ];
  const summary = plateRackSummary(sets, today);
  assert.equal(summary.avg_age_days, 5, 'every plate is five days old');
  assert.equal(summary.avg_runs, 4, '(11 + 0 + 1) / 3 = 4');
});

test('a plate with no recorded runs counts as unused, not as unknown', () => {
  // use_count is NOT NULL DEFAULT 0 in the schema, so a missing value means the
  // plate has never run — averaging it away would flatter the rack.
  const summary = plateRackSummary([
    { plate_size: '600 x 730', components: [{ id: 1, use_count: 4 }, { id: 2 }] },
  ]);
  assert.equal(summary.avg_runs, 2, '(4 + 0) / 2');
});

test('an empty rack summarises as zeroes, still naming both sizes', () => {
  const summary = plateRackSummary([]);
  assert.equal(summary.total, 0);
  assert.equal(summary.avg_age_days, 0);
  assert.deepEqual(summary.by_size.map(row => row.plate_size), ['600 x 730', '560 x 670']);
});

// This guard answers ONE question — "are these plates on the rack and free to take?"
// — and both retiring and ad-hoc issuing ask it. It carries no opinion about WHY the
// plates are being taken, which is why it is not named after either caller.
test('taking plates off the rack requires them to be there and available', () => {
  const rack = [
    { id: 1, component_label: 'Cyan', status: 'available' },
    { id: 2, component_label: 'Magenta', status: 'available' },
    { id: 3, component_label: 'Black', status: 'issued_to_printing' },
  ];
  assert.throws(() => pickAvailableRackPlates({ rackAssets: rack, assetIds: [] }),
    /at least one plate/i);
  // A plate on the press is not the rack's to give away — the run owns it.
  assert.throws(() => pickAvailableRackPlates({ rackAssets: rack, assetIds: [3] }), /Black/);
  assert.throws(() => pickAvailableRackPlates({ rackAssets: rack, assetIds: [99] }),
    /not in this rack/i);
  assert.deepEqual(
    pickAvailableRackPlates({ rackAssets: rack, assetIds: [1, 2] }).map(r => r.id), [1, 2]);
});

const RETURNED_SET = [
  { asset_id: 1, component_label: 'Cyan', use_count: 2 },
  { asset_id: 2, component_label: 'Magenta', use_count: 9 },
  { asset_id: 3, component_label: 'Black', use_count: 1 },
];

test('verification decides each returned plate on its own', () => {
  const decided = validateReturnVerification({
    components: RETURNED_SET,
    decisions: [
      { asset_id: 1, action: 'verified_ok' },
      { asset_id: 2, action: 'scrap' },
      { asset_id: 3, action: 'verified_ok' },
    ],
  });
  assert.deepEqual(decided.map(row => [row.asset_id, row.action]), [
    [1, 'verified_ok'], [2, 'scrap'], [3, 'verified_ok'],
  ]);
});

test('a plate left undecided blocks the whole verification', () => {
  // Half-verifying a set silently would leave plates parked in the queue with no
  // sign that anybody looked at them.
  assert.throws(() => validateReturnVerification({
    components: RETURNED_SET,
    decisions: [{ asset_id: 1, action: 'verified_ok' }],
  }), /Magenta|Black|every plate/i);
});

test('verification refuses a plate outside the set and an unknown action', () => {
  assert.throws(() => validateReturnVerification({
    components: RETURNED_SET,
    decisions: [...RETURNED_SET.map(c => ({ asset_id: c.asset_id, action: 'verified_ok' })),
      { asset_id: 99, action: 'scrap' }],
  }), /not part of this return/i);
  assert.throws(() => validateReturnVerification({
    components: RETURNED_SET,
    decisions: RETURNED_SET.map(c => ({ asset_id: c.asset_id, action: 'melt' })),
  }), /Used Plates Rack or Scrap/i);
});

test('an unticked plate is scrapped outright, not sent to the return queue', () => {
  const [scrapped] = validatePlateDispositions([{ id: 1, component_label: 'Black' }],
    [{ asset_id: 1, action: 'scrap' }]);
  assert.equal(scrapped.action, 'scrap');
  assert.equal(scrapped.condition, 'Scrapped', 'scrap is its own condition, not a grading');
});

test('scrapping from the press retires the asset instead of parking it', async () => {
  const statements = [];
  const assets = [{ id: 1, component_label: 'Black', request_component_id: 11, tooling_request_id: 7, current_job_card_id: 3, condition: 'Good' }];
  const qc = async (sql, params = []) => {
    statements.push({ sql, params });
    return /FROM job_stages/.test(sql) ? assets : [];
  };
  await applyPlateDispositions(qc, qc, 55, [{ asset_id: 1, action: 'scrap' }], 'Tester');

  const assetUpdate = statements.find(s => /UPDATE plate_assets SET status/.test(s.sql));
  assert.equal(assetUpdate.params[0], 'scrapped');
  assert.equal(assetUpdate.params[1], 'Scrapped');
  assert.ok(!assetUpdate.params.includes(PLATE_RETURN_QUEUE),
    'a scrapped plate must not sit in the queue waiting to be verified');
  const component = statements.find(s => /UPDATE plate_request_components SET status/.test(s.sql));
  assert.equal(component.params[0], 'scrapped');
});

test('a plate that never came back is recorded lost', () => {
  // The choice in the dropdown IS the reason, so a free-text note stays optional —
  // asking for it twice only slows the press down at the end of a run.
  const [bare] = validatePlateDispositions([{ id: 1, component_label: 'Yellow' }],
    [{ asset_id: 1, action: 'lost' }]);
  assert.equal(bare.action, 'lost');
  assert.equal(bare.condition, 'Lost', 'a lost plate is not Good, Fair or Damaged');
  const [explained] = validatePlateDispositions([{ id: 1, component_label: 'Yellow' }],
    [{ asset_id: 1, action: 'lost', note: 'destroyed on the press' }]);
  assert.equal(explained.note, 'destroyed on the press', 'a note is kept when it is given');
});

test('a lost plate goes to lost, never to the return queue', async () => {
  const statements = [];
  const assets = [{ id: 1, component_label: 'Yellow', request_component_id: 11, tooling_request_id: 7, current_job_card_id: 3, condition: 'Good' }];
  const qc = async (sql, params = []) => {
    statements.push({ sql, params });
    return /FROM job_stages/.test(sql) ? assets : [];
  };
  await applyPlateDispositions(qc, qc, 55, [{ asset_id: 1, action: 'lost', note: 'destroyed on the press' }], 'Tester');

  const assetUpdate = statements.find(s => /UPDATE plate_assets SET status/.test(s.sql));
  assert.equal(assetUpdate.params[0], 'lost');
  assert.equal(assetUpdate.params[1], 'Lost');
  assert.ok(
    !assetUpdate.params.includes(PLATE_RETURN_QUEUE),
    'a plate nobody handed back must not be parked in the return queue for someone to verify',
  );
});

test('the operator declares a condition per plate, defaulting to Good', () => {
  const [good] = validatePlateDispositions([{ id: 1 }], [{ asset_id: 1, action: 'return' }]);
  assert.equal(good.condition, 'Good');
  const [fair] = validatePlateDispositions([{ id: 1 }], [{ asset_id: 1, action: 'return', condition: 'Fair' }]);
  assert.equal(fair.condition, 'Fair');
});

test('a plate coming off the press cannot be declared scrapped or invented', () => {
  // Scrapped/Lost are outcomes the warehouse owns at verification, not observations
  // the press makes — offering them here would bypass the physical-inspection gate.
  for (const condition of ['Scrapped', 'Lost', 'Excellent', '']) {
    assert.throws(
      () => validatePlateDispositions([{ id: 1 }], [{ asset_id: 1, action: 'return', condition }]),
      /Good, Fair or Damaged/,
      `${condition || '(blank)'} should be refused`,
    );
  }
});

test('declaring a plate Damaged stands on its own, with the note optional', () => {
  const [damaged] = validatePlateDispositions([{ id: 1, component_label: 'Black' }],
    [{ asset_id: 1, action: 'return', condition: 'Damaged' }]);
  assert.equal(damaged.condition, 'Damaged');
  assert.equal(damaged.note, null);
  const [explained] = validatePlateDispositions([{ id: 1, component_label: 'Black' }],
    [{ asset_id: 1, action: 'return', condition: 'Damaged', note: 'scored during washup' }]);
  assert.equal(explained.note, 'scored during washup');
});

const ISSUED = [
  { id: 1, component_label: 'Cyan' },
  { id: 2, component_label: 'Cyan' },
  { id: 3, component_label: 'Black' },
];

test('a mid-run replacement names the plates and the reason', () => {
  const picked = validatePlateReplacementRequest({
    issuedAssets: ISSUED, assetIds: [3], reason: 'Damaged on machine',
  });
  assert.deepEqual(picked.map(row => row.id), [3]);
});

test('a replacement request cannot be raised empty or for a plate not on the press', () => {
  assert.throws(() => validatePlateReplacementRequest({
    issuedAssets: ISSUED, assetIds: [], reason: 'Damaged on machine',
  }), /at least one plate/i);
  // Guards against a stale form: the plate list is refetched per job, and acting
  // on an id from another job would damage a plate nobody asked about.
  assert.throws(() => validatePlateReplacementRequest({
    issuedAssets: ISSUED, assetIds: [99], reason: 'Damaged on machine',
  }), /not issued to this job/i);
});

test('the reason is required, from the list, and Other must be explained', () => {
  assert.throws(() => validatePlateReplacementRequest({
    issuedAssets: ISSUED, assetIds: [3], reason: '',
  }), /reason/i);
  assert.throws(() => validatePlateReplacementRequest({
    issuedAssets: ISSUED, assetIds: [3], reason: 'Fell on the floor',
  }), /reason/i);
  assert.throws(() => validatePlateReplacementRequest({
    issuedAssets: ISSUED, assetIds: [3], reason: 'Other',
  }), /say what happened/i);
  assert.equal(validatePlateReplacementRequest({
    issuedAssets: ISSUED, assetIds: [3], reason: 'Other', note: 'dropped in the sink',
  }).length, 1);
});

test('the issued set summarises as a per-colour breakup and a total', () => {
  const issued = [
    { id: 1, component_type: 'cyan', component_label: 'Cyan' },
    { id: 2, component_type: 'cyan', component_label: 'Cyan' },
    { id: 3, component_type: 'magenta', component_label: 'Magenta' },
    { id: 4, component_type: 'pantone', component_label: 'Pantone - 293 C', pantone_code: '293 C' },
  ];
  const summary = issuedPlateSummary(issued);
  assert.equal(summary.total, 4);
  assert.deepEqual(summary.breakup.map(row => [row.component_label, row.qty]), [
    ['Cyan', 2], ['Magenta', 1], ['Pantone - 293 C', 1],
  ]);
});

test('an empty issue summarises as nothing rather than throwing', () => {
  assert.deepEqual(issuedPlateSummary([]), { total: 0, breakup: [] });
  assert.deepEqual(issuedPlateSummary(null), { total: 0, breakup: [] });
});

test('a return set is keyed by condition, so a mixed set verifies as two groups', () => {
  const base = {
    tooling_request_id: 7, job_card_id: 3, source_grn_id: null, product_id: 12,
    output_number: 'OUT-9001', artwork_version: 'AW-9001-R2', plate_master_id: 2,
  };
  assert.equal(
    plateReturnSetKey({ ...base, condition: 'Good' }),
    plateReturnSetKey({ ...base, condition: 'Good' }),
    'same job and same condition stay one set',
  );
  assert.notEqual(
    plateReturnSetKey({ ...base, condition: 'Good' }),
    plateReturnSetKey({ ...base, condition: 'Damaged' }),
    'a damaged plate must not be collapsed into the clean set',
  );
  assert.notEqual(
    plateReturnSetKey({ ...base, condition: 'Good' }),
    plateReturnSetKey({ ...base, job_card_id: 4, condition: 'Good' }),
    'different jobs stay different sets',
  );
});

test('the condition the press declared is what reaches the asset and the movement', async () => {
  const statements = [];
  const assets = [{ id: 1, component_label: 'Black', request_component_id: 11, tooling_request_id: 7, current_job_card_id: 3, condition: 'Good' }];
  const qc = async (sql, params = []) => {
    statements.push({ sql, params });
    return /FROM job_stages/.test(sql) ? assets : [];
  };
  await applyPlateDispositions(qc, qc, 55, [{ asset_id: 1, action: 'return', condition: 'Damaged', note: 'scored' }], 'Tester');

  const assetUpdate = statements.find(s => /UPDATE plate_assets SET status/.test(s.sql));
  assert.equal(assetUpdate.params[1], 'Damaged', 'the asset keeps the press verdict, not its old condition');
  const movement = statements.find(s => /INSERT INTO plate_asset_movements/.test(s.sql));
  assert.ok(movement.params.includes('Damaged'), 'the movement records the declared condition');
});

