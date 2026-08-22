import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import {
  expandPlateQuantities, plateComponentsFromSpec, suggestedPlateQuantities,
} from './plates.js';
import { gangPlateSpecification, plateSpecification } from './plate-lifecycle.js';
import {
  DRIPOFF_TYPE, DRIPOFF_LABEL, DRIP_OFF_PLATE_SIZE,
  isDripOff, hasDripOffCoating,
  groupedComponents, inkOrder, inkSummary, shortComponent,
} from '../../client/src/lib/plateInks.js';

// ── THE DRIP OFF PLATE ────────────────────────────────────────────────────
//
// A product whose coating is Drip Off needs one more plate than its colour
// build says: the drip-off varnish mask. It is NOT an ink —
//   • it never joins the colour counts (colors stays the ink total);
//   • its own default size is 560 x 670 even when the colour set is 600 x 730;
//   • it is issued at COATING start, never printing;
//   • it never returns to the rack — one run and it is consumed.
// This file pins each of those, plus the naming: the word everywhere is
// DRIP OFF, never a Pantone in disguise.

const DRIP_SPEC = {
  product_name: 'Amoxy 500 Carton',
  colour_type: 'CMYK',
  cmyk_colours: 4,
  coating: 'Drip Off',
  party_artwork_code: 'PCS-W026/R1',
};

test('hasDripOffCoating reads the real master labels, case- and punctuation-blind', () => {
  for (const coating of ['Drip Off', 'DRIP-OFF UV', 'drip off + spot uv', 'Dripoff']) {
    assert.equal(hasDripOffCoating({ coating }), true, `${coating} is a drip-off coating`);
  }
  for (const coating of ['Aqueous Varnish', 'Full UV', 'Aqueous Varnish + Spot UV', '', null, undefined]) {
    assert.equal(hasDripOffCoating({ coating }), false, `${coating} is not drip off`);
  }
});

test('a Drip Off product derives one extra DRIP OFF plate, after the inks', () => {
  const components = plateComponentsFromSpec(DRIP_SPEC);
  assert.equal(components.length, 5, 'CMYK + the drip-off mask');
  const drip = components[components.length - 1];
  assert.equal(drip.component_type, DRIPOFF_TYPE);
  assert.equal(drip.component_label, DRIPOFF_LABEL);
  assert.equal(drip.pantone_code, null);
  assert.deepEqual(components.map(row => row.sequence_no), [1, 2, 3, 4, 5], 'sequence stays contiguous');
});

test('the DRIP OFF plate never counts as a colour — legacy totals still backfill inks only', () => {
  // A legacy master carrying only colour_type + colors must still get its six
  // ink plates; the drip mask rides on top rather than eating a Pantone slot.
  const components = plateComponentsFromSpec({
    colour_type: 'CMYK + Pantone', colors: 6, coating: 'Drip Off UV',
  });
  assert.equal(components.length, 7, '6 ink plates + 1 DRIP OFF');
  assert.equal(components.filter(isDripOff).length, 1);
  assert.equal(components.filter(row => row.component_type === 'pantone').length, 2,
    'the colour backfill is untouched by the drip mask');
});

test('a product without drip off derives no DRIP OFF plate', () => {
  const components = plateComponentsFromSpec({ colour_type: 'CMYK', cmyk_colours: 4, coating: 'Aqueous Varnish' });
  assert.equal(components.some(isDripOff), false);
});

test('expandPlateQuantities accepts DRIP OFF rows without demanding a Pantone identity', () => {
  const rows = expandPlateQuantities([
    { component_type: 'cyan', qty: 1 },
    { component_type: 'dripoff', qty: 2 },
  ]);
  const drip = rows.filter(isDripOff);
  assert.equal(drip.length, 2, 'qty expands to one row per physical plate');
  assert.ok(drip.every(row => row.component_label === DRIPOFF_LABEL));
  assert.ok(drip.every(row => row.pantone_code === null));
});

test('a DRIP OFF row carries its own size, defaulting 560 x 670 whatever the set uses', () => {
  const [drip] = expandPlateQuantities([{ component_type: 'dripoff', qty: 1 }]).filter(isDripOff);
  assert.equal(drip.plate_size, DRIP_OFF_PLATE_SIZE);
  assert.equal(DRIP_OFF_PLATE_SIZE, '560 x 670');
  const [sized] = expandPlateQuantities([{ component_type: 'dripoff', qty: 1, plate_size: '600 x 730' }]);
  assert.equal(sized.plate_size, '600 x 730', 'an explicit size is kept — 560 x 670 is a default, not a law');
  const [cyan] = expandPlateQuantities([{ component_type: 'cyan', qty: 1 }]);
  assert.equal(cyan.plate_size, undefined, 'ink rows keep using the requirement-level size');
});

test('suggestedPlateQuantities folds the drip mask into one qty-1 line', () => {
  const rows = suggestedPlateQuantities(DRIP_SPEC);
  const drip = rows.find(isDripOff);
  assert.ok(drip, 'the manual-entry form is offered the DRIP OFF line');
  assert.equal(drip.qty, 1);
});

test('plateSpecification carries the coating, so a fired PR can derive the drip plate', () => {
  const spec = plateSpecification({ name: 'X', code: 'X-1', coating: 'Drip Off' });
  assert.equal(spec.coating, 'Drip Off');
});

test('a gang with one drip-off member gets ONE drip plate, and it never inflates the colour count', () => {
  const gang = { id: 9, gang_number: 'CI-GANG-0009', output_number: 'OUT-9' };
  const members = [
    { name: 'A', code: 'A1', colour_type: 'CMYK', cmyk_colours: 4, coating: 'Drip Off', output_number: 'OUT-9' },
    { name: 'B', code: 'B1', colour_type: 'CMYK', cmyk_colours: 4, coating: 'Drip Off UV', output_number: 'OUT-9' },
    { name: 'C', code: 'C1', colour_type: 'CMYK', cmyk_colours: 4, coating: 'Aqueous Varnish', output_number: 'OUT-9' },
  ];
  const spec = gangPlateSpecification(gang, members);
  assert.equal(spec.colors, 4, 'colors is the INK build — the drip mask is not a colour');
  assert.equal(hasDripOffCoating(spec), true, 'the gang spec remembers the coating');
  const components = plateComponentsFromSpec(spec);
  assert.equal(components.filter(isDripOff).length, 1, 'one shared sheet, one drip mask');
});

test('the queue build says CMYK + DRIP OFF — never CMYKDO, never a fifth Pantone', () => {
  const components = [
    { component_type: 'cyan', component_label: 'Cyan', status: 'pr_required' },
    { component_type: 'magenta', component_label: 'Magenta', status: 'pr_required' },
    { component_type: 'yellow', component_label: 'Yellow', status: 'pr_required' },
    { component_type: 'black', component_label: 'Black', status: 'pr_required' },
    { component_type: 'dripoff', component_label: DRIPOFF_LABEL, status: 'pr_required' },
  ];
  const labels = inkSummary(components).map(part => part.label);
  assert.deepEqual(labels, ['CMYK', DRIPOFF_LABEL]);
});

test('press order: inks first, spots next, the DRIP OFF mask last', () => {
  const ordered = inkOrder(groupedComponents([
    { component_type: 'dripoff', component_label: DRIPOFF_LABEL, status: 'pr_required' },
    { component_type: 'pantone', component_label: 'Pantone - 485C', pantone_code: '485C', status: 'pr_required' },
    { component_type: 'black', component_label: 'Black', status: 'pr_required' },
  ]));
  assert.deepEqual(ordered.map(row => row.component_type), ['black', 'pantone', 'dripoff']);
});

test('two DRIP OFF plates group as one line of two — and the short code is DO, not a colour letter', () => {
  const grouped = groupedComponents([
    { component_type: 'dripoff', component_label: DRIPOFF_LABEL, status: 'pr_required' },
    { component_type: 'dripoff', component_label: DRIPOFF_LABEL, status: 'pr_required' },
  ]);
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].qty, 2);
  assert.equal(shortComponent({ component_type: DRIPOFF_TYPE, component_label: DRIPOFF_LABEL }), 'DO');
});

test('a consumed DRIP OFF never nags "Replace" — it is finished, not awaiting replacement', async () => {
  const { plateWearSummary, plateWearRemark } = await import('./plates.js');
  // The exact post-coating state: ink plates back on the rack, the mask consumed.
  const components = [
    { component_type: 'cyan', component_label: 'Cyan', status: 'available',
      matched_asset_id: 11, matched_asset_number: 'CI-PL-A-0011', matched_use_count: 1, matched_condition: 'Good' },
    { component_type: 'dripoff', component_label: DRIPOFF_LABEL, status: 'scrapped',
      matched_asset_id: 12, matched_asset_number: 'CI-PL-A-0012', matched_use_count: 1, matched_condition: 'Scrapped' },
  ];
  const summary = plateWearSummary(components);
  assert.equal(summary.replace.length, 0, 'nothing is due for replacement');
  assert.ok(!/Replace/.test(plateWearRemark(summary)), 'the remark must not demand a plate that no longer exists');
});

test('one drip-plate state vocabulary for the traveler and the Status Sheet', async () => {
  const { dripPlateStateLabel } = await import('../../client/src/lib/plateInks.js');
  // Consumed, not "Scrapped": scrap is the mask's NORMAL end — on the papers
  // the plant reads, "Scrapped" would raise an alarm about a plate that simply
  // did its one job.
  assert.equal(dripPlateStateLabel('scrapped'), 'Consumed');
  assert.equal(dripPlateStateLabel('issued'), 'Issued to coating');
  for (const status of ['verified_existing', 'available', 'reserved']) {
    assert.equal(dripPlateStateLabel(status), 'Ready on rack', status);
  }
  for (const status of ['approved', 'po_created', 'ordered', 'grn_received']) {
    assert.equal(dripPlateStateLabel(status), 'On order', status);
  }
  assert.equal(dripPlateStateLabel('verification_required'), 'Verify rack plate');
  for (const status of ['pr_required', 'replacement_required', 'not_found']) {
    assert.equal(dripPlateStateLabel(status), 'To buy', status);
  }
  assert.equal(dripPlateStateLabel(null), null, 'no component, no state');
});

test('the Job Card payload carries the drip plate for the printed traveler', () => {
  const attach = sliceOf(productionRoute, 'async function attachTools', 2200);
  assert.match(attach, /dripoff_plate/, 'attachTools does not attach the drip plate');
  assert.match(attach, /component_type\s*=\s*'dripoff'/, 'the lateral must pick the DRIP OFF component');
  assert.match(attach, /plate_size/, 'the traveler needs the plate size (560 x 670 by default)');
});

test('the Status Sheet payload carries each line\'s drip plate state', () => {
  const ordersRoute = readFileSync(new URL('./routes/orders.js', import.meta.url), 'utf8');
  const sheet = sliceOf(ordersRoute, "r.get('/status-sheet'", 8000);
  assert.match(sheet, /dripoff_plate/, 'the status-sheet rows do not carry the drip plate');
  assert.match(sheet, /component_type\s*=\s*'dripoff'/);
  assert.match(sheet, /p\.coating/, 'the sheet needs the coating to say "required, not raised" without a PR');
});

// ── The lifecycle, pinned in the source ───────────────────────────────────
// No test here touches a database; the engine functions are SQL wrapped in a
// transaction, so what can be pinned is the shape of that SQL and who calls it.
// Slice guards assert length first — a slice anchored on a moved name silently
// asserts nothing (see the source-text trap in plate-rack-picker).

const lifecycle = readFileSync(new URL('./plate-lifecycle.js', import.meta.url), 'utf8');
const productionRoute = readFileSync(new URL('./routes/production.js', import.meta.url), 'utf8');
const platesRoute = readFileSync(new URL('./routes/plates.js', import.meta.url), 'utf8');

const sliceOf = (source, anchor, length = 2600) => {
  const at = source.indexOf(anchor);
  assert.ok(at >= 0, `anchor "${anchor}" is missing`);
  const body = source.slice(at, at + length);
  assert.ok(body.length > 200, `slice at "${anchor}" is too short to prove anything`);
  return body;
};

test('printing start issues the INK plates only — the drip mask has nothing to do with printing', () => {
  const issue = sliceOf(lifecycle, 'export async function issuePlateAssetsForJob');
  assert.match(issue, /component_type\s*<>\s*'dripoff'/,
    "issuePlateAssetsForJob no longer excludes dripoff — printing start would carry the coating plate to the press");
  const readiness = sliceOf(lifecycle, 'export async function plateReadinessForPrinting');
  assert.match(readiness, /component_type\s*<>\s*'dripoff'/,
    'plateReadinessForPrinting counts the drip mask — printing would report a shortage over a plate coating owns');
});

test('coating start auto-issues the DRIP OFF plate from the rack, named as coating work', () => {
  const issue = sliceOf(lifecycle, 'export async function issueDripOffPlatesForJob');
  assert.match(issue, /'issued_to_coating'/, 'the issued status must say coating, not printing');
  assert.match(issue, /'Coating'/, 'the plate location must say Coating');
  assert.ok(!/issued_to_printing/.test(issue), 'a drip plate must never read as issued to printing');
  assert.match(issue, /component_type\s*=\s*'dripoff'/, 'only the drip mask issues at coating');
});

test('coating start never raises a purchase request when the rack is empty', () => {
  const issue = sliceOf(lifecycle, 'export async function issueDripOffPlatesForJob');
  assert.ok(!/INSERT INTO tooling_requests/.test(issue),
    'issueDripOffPlatesForJob raises plate paperwork — raising plates stays a human decision');
});

test('coating completion consumes the drip plate — no return queue, no reuse', () => {
  const consume = sliceOf(lifecycle, 'export async function consumeDripOffPlatesForStage');
  assert.match(consume, /'scrapped'/, 'a used drip plate is finished — it scraps');
  assert.match(consume, /issued_to_coating/, 'it sweeps what coating is holding');
  assert.ok(!/PLATE_RETURN_QUEUE|returned_pending_verification/.test(consume),
    'a drip plate joined the Plate Return Queue — there is no reuse of a drip plate');
  assert.match(consume, /js\.stage\s*=\s*'coating'/, 'the sweep is scoped to the coating stage');
});

test('the production route wires both coating hooks', () => {
  assert.match(productionRoute, /st\.stage === 'coating'[\s\S]{0,400}issueDripOffPlatesForJob/,
    'coating start does not auto-issue the DRIP OFF plate');
  assert.match(productionRoute, /st\.stage === 'coating'[\s\S]{0,400}consumeDripOffPlatesForStage/,
    'coating completion does not consume the DRIP OFF plate');
});

test('a drip plate issued by hand from the warehouse is coating work too', () => {
  const issue = sliceOf(platesRoute, "r.post('/plates/assets/issue'", 3200);
  assert.match(issue, /issued_to_coating/,
    'the manual issue door sends a DRIP OFF plate out as issued_to_printing');
});

test('init() replays 0035 for FRESH databases only — its old approval CHECK kills a live one', () => {
  // 0035 re-ADDs the ORIGINAL approval_status list on every boot, but
  // 20260808071000 both widened that list and backfilled rows to 'saved'. On a
  // database holding a draft/saved Plate PR the re-ADD fails validation and the
  // server never comes up — found by booting the app on a database where the
  // drip-off E2E had just saved a PR. Same guard style plate_rates already uses.
  const db = readFileSync(new URL('./db.js', import.meta.url), 'utf8');
  const at = db.indexOf('0035_tooling_procurement_warehouses.sql');
  assert.ok(at > 0, '0035 is still replayed for fresh databases');
  const guard = db.slice(Math.max(0, at - 1200), at);
  assert.match(guard, /to_regclass\('public\.tooling_purchase_orders'\)/,
    'the 0035 replay is unguarded — restarting a server over a saved/draft Plate PR fails its old approval_status CHECK');
});

test('a re-ADDed CHECK never NARROWS the one it replaces — every earlier value survives', () => {
  // The 0035 boot failure in reverse, and the reason this file carries both:
  // a DROP-then-ADD is replay-safe but it REPLACES, so re-adding a constraint
  // from an older spelling silently deletes every value a later migration
  // added. Prod's plate_assets_status_check carried 'replaced' and 'reversed'
  // (20260808071000, the reversibility wave — routes/plates.js:1470 writes
  // 'reversed' when a plate GRN is reversed). The drip migration re-added the
  // status CHECK from the ORIGINAL lifecycle list, so applying it would have
  // dropped both and broken GRN reversal — locally too, since init() replays
  // the drip file last.
  //
  // Asserted as a SUPERSET rule over the migration text rather than as one
  // hand-written list, so it keeps holding for whatever the next wave adds.
  const dir = new URL('../../supabase/migrations/', import.meta.url);
  const valuesOf = (sql, constraint) => {
    const at = sql.indexOf(`ADD CONSTRAINT ${constraint}`);
    if (at < 0) return null;
    const body = sql.slice(at, sql.indexOf(');', at));
    return new Set([...body.matchAll(/'([a-z_]+)'/g)].map(m => m[1]));
  };
  const files = readdirSync(dir).filter(f => f.endsWith('.sql') && !/baseline/i.test(f)).sort();
  const CONSTRAINTS = [
    'plate_assets_status_check',
    'plate_assets_component_type_check',
    'plate_request_components_component_type_check',
  ];
  for (const constraint of CONSTRAINTS) {
    let established = null;
    let from = null;
    for (const file of files) {
      const values = valuesOf(readFileSync(new URL(file, dir), 'utf8'), constraint);
      if (!values) continue;
      if (established) {
        const lost = [...established].filter(value => !values.has(value));
        assert.deepEqual(lost, [],
          `${file} re-adds ${constraint} without ${lost.join(', ')} — values ${from} established. `
          + 'A DROP-then-ADD REPLACES the constraint, so every earlier value must be carried forward.');
      }
      established = values;
      from = file;
    }
    assert.ok(established, `no migration defines ${constraint}`);
  }
});

test('the schema learns dripoff and issued_to_coating through a replayable migration', () => {
  const dir = new URL('../../supabase/migrations/', import.meta.url);
  const file = readdirSync(dir).find(name => /plate.*dripoff/.test(name));
  assert.ok(file, 'no plate dripoff migration exists');
  const sql = readFileSync(new URL(file, dir), 'utf8');
  assert.match(sql, /'dripoff'/, 'component_type CHECKs must allow dripoff');
  assert.match(sql, /'issued_to_coating'/, 'plate_assets.status must allow issued_to_coating');
  assert.match(sql, /allowed_components/, 'the plate masters must allow the dripoff component');
  assert.match(sql, /DROP CONSTRAINT IF EXISTS/, 'constraint swaps must be replay-safe — init() runs on every boot');
});
