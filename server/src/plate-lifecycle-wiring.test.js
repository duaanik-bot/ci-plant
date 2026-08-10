import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');

test('the Plate lifecycle router is mounted and realtime-enabled', () => {
  const app = read('server/src/app.js');
  const realtime = read('client/src/lib/realtimeTables.js');
  assert.match(app, /import plates from '\.\/routes\/plates\.js'/);
  assert.match(app, /app\.use\('\/api', plates\)/);
  for (const table of ['plate_masters','plate_assets','plate_request_components','plate_asset_movements']) {
    assert.match(realtime, new RegExp(`'${table}'`));
  }
});

test('Job Card finalisation, printing start and printing completion share the lifecycle', () => {
  const route = read('server/src/routes/production.js');
  assert.match(route, /auto_from_finalise/);
  assert.match(route, /assertPlateReadyForPrinting\(qc, jc\.id/);
  assert.match(route, /issuePlateAssetsForJob\(qc, oc, jc, machineId/);
  assert.match(route, /applyPlateDispositions\(qc, oc, st\.id, req\.body\.plate_dispositions/);
});

test('the printing completion form returns issued plates to verification', () => {
  const section = read('client/src/pages/Section.jsx');
  assert.match(section, /Return Plates/);
  assert.match(section, /plate_dispositions:/);
  assert.match(section, /action: 'return'/);
});

test('Plates exposes the six requested operational views', () => {
  const page = read('client/src/components/PlatesLifecycle.jsx');
  for (const label of ['Plate Requirements / PR','Purchase Orders','GRN','Plates Warehouse','Return from Printing','History']) {
    assert.ok(page.includes(label), `${label} is missing`);
  }
});

test('Plate PRs expose save, partial approval, unapproval and authorised deletion', () => {
  const route = read('server/src/routes/plates.js');
  const page = read('client/src/components/PlatesLifecycle.jsx');
  assert.match(route, /r\.put\('\/plates\/requirements\/:id', canBuy/);
  assert.match(route, /r\.post\('\/plates\/requirements\/:id\/unapprove', canBuy/);
  assert.match(route, /r\.delete\('\/plates\/requirements\/:id', canBuy/);
  assert.match(route, /r\.delete\('\/plates\/requirements\/bulk', canBuy/);
  assert.match(route, /Record why this Plate PR is being deleted/);
  assert.match(route, /\['saved','approved'\]\.includes\(request\.approval_status\)/);
  for (const label of ['Save Changes','Delete Plate PR','Unapprove','Add Pantone']) {
    assert.ok(page.includes(label), `${label} is missing`);
  }
});

test('Plate requirements support select all, bulk PO and atomic bulk PR deletion', () => {
  const route = read('server/src/routes/plates.js');
  const page = read('client/src/components/PlatesLifecycle.jsx');
  assert.ok(route.indexOf("r.delete('/plates/requirements/bulk'") < route.indexOf("r.delete('/plates/requirements/:id'"));
  assert.match(route, /deletePlateRequirements\(qc, oc, requestIds, reason/);
  assert.match(route, /WHERE id=ANY\(\$1::int\[\]\) AND family='plate' ORDER BY id FOR UPDATE/);
  assert.match(page, /<DataTable searchable selectable rows=\{reqRows\}/);
  for (const label of ['Select all','Deselect all','Create Bulk PO','Delete PRs']) {
    assert.ok(page.includes(label), `${label} is missing`);
  }
  assert.match(page, /groups: groups\.map/);
});

test('Plate PO and GRN reversal endpoints enforce downstream-first reversal', () => {
  const route = read('server/src/routes/plates.js');
  assert.match(route, /r\.post\('\/plates\/purchase-orders\/:id\/reverse', canBuy/);
  assert.match(route, /must be reversed before reversing/);
  assert.match(route, /r\.post\('\/plates\/grns\/:id\/reverse', canBuy/);
  assert.match(route, /has entered production and prevents GRN reversal/);
  assert.match(route, /status='reversed',reversed_at=now\(\),reversed_by=/);
});

test('the Plate editor keeps physical rows and grouped quantities in sync', () => {
  const page = read('client/src/components/PlatesLifecycle.jsx');
  assert.match(page, /function QuantityControl/);
  assert.match(page, /0 removes a colour/);
  assert.match(page, /draftTotal\(editForm\)/);
  assert.match(page, /Pantone identity retained on every physical plate/);
});

test('Plate PR and PO forms default to the controlled size and Kansal Graphics', () => {
  const route = read('server/src/routes/plates.js');
  const page = read('client/src/components/PlatesLifecycle.jsx');
  assert.match(route, /lower\(trim\(name\)\)='kansal graphics'/);
  assert.match(route, /suggested_plate_master_id/);
  assert.match(route, /suggested_vendor_id/);
  assert.match(page, /request\.suggested_plate_master_id/);
  assert.match(page, /request\.suggested_vendor_id/);
});

test('Product colours and Plate Rates flow into finalized Plate PO rows', () => {
  const page = read('client/src/components/PlatesLifecycle.jsx');
  const product = read('client/src/lib/productMasterConfig.js');
  const route = read('server/src/routes/plates.js');
  const rates = read('server/src/routes/plate-rates.js');
  const procurementForms = read('client/src/components/ProcurementForms.jsx');
  const migration = read('supabase/migrations/20260808085337_plate_rates_master.sql');
  assert.match(product, /Total No\. of Colours/);
  assert.match(page, /Fetch Master Colours/);
  assert.match(page, /Finalized Plates/);
  assert.match(page, /Plate Size/);
  assert.match(page, /Master Rs/);
  assert.match(page, /PoTotalsPanel/);
  assert.match(procurementForms, /Grand Total/);
  assert.match(route, /resolvePlateRate\(rates, components\[0\]\.plate_master_id, vendorId\)/);
  assert.match(rates, /r\.get\('\/plate-rates'/);
  assert.match(migration, /rate_per_plate NUMERIC\(12,2\)/);
  assert.match(migration, /SELECT pm\.id, NULL, 200/);
});

test('Gang Plate demand stays unified and Output remains visible throughout the lifecycle', () => {
  const production = read('server/src/routes/production.js');
  const tooling = read('server/src/routes/tooling.js');
  const route = read('server/src/routes/plates.js');
  const page = read('client/src/components/PlatesLifecycle.jsx');
  assert.match(production, /gangPlateSpecification\(gang, uniqueTargets\)/);
  assert.match(tooling, /gangPlateSpecification\(gang, targets\)/);
  assert.match(route, /tr\.specification->>'output_number'/);
  for (const label of ['Unified gang plate','Gang members','All approvals','Approved','Unapproved','Output']) {
    assert.ok(page.includes(label), `${label} is missing`);
  }
});

test('Converted Plate PRs leave the open queue and move to the converted chip', () => {
  const route = read('server/src/routes/plates.js');
  const page = read('client/src/components/PlatesLifecycle.jsx');
  assert.match(route, /UPDATE tooling_requests SET approval_status='converted'/);
  assert.match(page, /const isConvertedPr = row => row\.approval_status === 'converted' \|\| !!row\.po_number/);
  assert.match(page, /open: requirements\.filter\(row => !row\.plate_summary\?\.is_ready && !isConvertedPr\(row\)\)/);
  assert.match(page, /converted: requirements\.filter\(isConvertedPr\)/);
  assert.match(page, /\{key:'converted',label:'Converted',count:reqGroups\.converted\.length\}/);
  assert.match(page, /reqView !== 'converted' && <SubTabs active=\{approvalView\}/);
});

test('Plate Warehouse separates fresh and used set-level inventory', () => {
  const route = read('server/src/routes/plates.js');
  const page = read('client/src/components/PlatesLifecycle.jsx');
  const helpers = read('server/src/helpers.js');
  const backfill = read('supabase/migrations/20260810051454_backfill_legacy_plate_assets_to_fresh_rack.sql');
  assert.match(route, /FRESH_PLATES_RACK/);
  assert.match(route, /USED_PLATES_RACK/);
  assert.match(route, /groupPlateSets\(rows/);
  assert.match(route, /status='available'/);
  assert.match(page, /Fresh Plates Rack/);
  assert.match(page, /Used Plates Rack/);
  assert.match(page, /Move to Used Rack/);
  assert.match(page, /Move to Scrap/);
  assert.doesNotMatch(page, /Damaged \/ Hold/);
  assert.doesNotMatch(helpers, /'issued','returned_pending_verification'\)\)::int AS ready/);
  assert.match(backfill, /status='available',rack_location='Fresh Plates Rack'/);
  assert.match(backfill, /'location_changed'/);
});

test('the controlled master seeds two sizes, not ten colour SKUs', () => {
  const migration = read('supabase/migrations/20260808054658_plate_asset_lifecycle.sql');
  assert.match(migration, /'560 x 670'/);
  assert.match(migration, /'600 x 730'/);
  assert.match(migration, /allowed_components TEXT\[\]/);
  assert.doesNotMatch(migration, /560 x 670[^\n]*Cyan/i);
});

// ── The plate gate reaches the operator ───────────────────────────────────
// It shipped as a structured 409, and api.js suppresses the central toast for
// any error carrying a `code` because the convention is that the caller draws
// a modal. Nothing drew one, so Start Run did nothing at all — no toast, no
// dialog, no reason — on all three pages that start a printing stage.

test('every page that starts printing answers a plate refusal', () => {
  for (const path of ['client/src/pages/Section.jsx', 'client/src/pages/Floor.jsx', 'client/src/pages/Production.jsx']) {
    const page = read(path);
    assert.match(page, /PLATES_NOT_READY/, `${path} ignores the plate refusal`);
    assert.match(page, /ack_plates/, `${path} offers no way past the plate refusal`);
  }
});

test('the printing start carries the plate acknowledgement and records who gave it', () => {
  const route = read('server/src/routes/production.js');
  assert.match(route, /assertPlateReadyForPrinting\(qc, jc\.id, req\.body\.ack_plates\)/);
  assert.match(route, /ack_plates_not_ready/);
});

test('a structured refusal no caller renders still reaches the user', () => {
  const api = read('client/src/api.js');
  // The blanket "any code means someone drew a modal" rule is what made the
  // refusal invisible. Suppression must be opt-in per code, so a new server
  // code that nobody wired up degrades to a visible toast, never to silence.
  assert.doesNotMatch(api, /if \(!data\.code\) onError\(msg\)/);
  assert.match(api, /const HANDLED_CODES = new Set\(\[/);
  // Both exits — request() and upload() — must consult the list, or half the
  // app keeps the old silent behaviour.
  assert.equal((api.match(/HANDLED_CODES\.has\(data\.code\)/g) || []).length, 2);
  // The gate that started this must be on the list AND have its dialog, which
  // is the pairing the previous test proves for all three pages.
  assert.match(api, /'PLATES_NOT_READY'/);
});
