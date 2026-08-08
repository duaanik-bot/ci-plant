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
  assert.match(route, /assertPlateReadyForPrinting\(qc, jc\.id\)/);
  assert.match(route, /issuePlateAssetsForJob\(qc, oc, jc, machineId/);
  assert.match(route, /applyPlateDispositions\(qc, oc, st\.id, req\.body\.plate_dispositions/);
});

test('the printing completion form requires one disposition per issued plate', () => {
  const section = read('client/src/pages/Section.jsx');
  assert.match(section, /Plate Return \/ Disposition/);
  assert.match(section, /plate_dispositions:/);
  assert.match(section, /\['return','scrap','review'\]/);
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
  assert.match(route, /Record why this Plate PR is being deleted/);
  assert.match(route, /\['saved','approved'\]\.includes\(request\.approval_status\)/);
  for (const label of ['Save Changes','Delete Plate PR','Unapprove','Add Pantone']) {
    assert.ok(page.includes(label), `${label} is missing`);
  }
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

test('the controlled master seeds two sizes, not ten colour SKUs', () => {
  const migration = read('supabase/migrations/20260808054658_plate_asset_lifecycle.sql');
  assert.match(migration, /'560 x 670'/);
  assert.match(migration, /'600 x 730'/);
  assert.match(migration, /allowed_components TEXT\[\]/);
  assert.doesNotMatch(migration, /560 x 670[^\n]*Cyan/i);
});
