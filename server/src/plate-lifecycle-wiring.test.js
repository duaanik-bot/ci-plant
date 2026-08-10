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

// The plate warehouse is DETACHED from the plant flow. It is being built out
// locally, and while it is, no half-built module may stand between a press and
// its run: the gate refused four jobs — three of them on Offset 3 — and, worse,
// refused them in silence. Nothing about the module is deleted; the plant flow
// simply does not consult it. Re-attaching means deliberately failing this test
// and writing the wiring back, which is the point of stating it this way.
test('the plant flow does not consult the plate warehouse', () => {
  const route = read('server/src/routes/production.js');
  for (const hook of ['auto_from_finalise', 'assertPlateReadyForPrinting',
    'issuePlateAssetsForJob', 'applyPlateDispositions', 'createPlateComponents']) {
    assert.doesNotMatch(route, new RegExp(`${hook}\\(`), `${hook} is wired back into the plant flow`);
  }
  // Detached, not deleted — the module still has to work for the local build.
  const lifecycle = read('server/src/plate-lifecycle.js');
  for (const fn of ['assertPlateReadyForPrinting', 'issuePlateAssetsForJob', 'applyPlateDispositions']) {
    assert.match(lifecycle, new RegExp(`export async function ${fn}`), `${fn} was deleted, not detached`);
  }
});

test('the printing completion form returns issued plates to verification', () => {
  const section = read('client/src/pages/Section.jsx');
  assert.match(section, /Return Plates/);
  assert.match(section, /plate_dispositions:/);
  // A plate the press still holds is returned for verification; only an unticked
  // one takes the other branch.
  assert.match(section, /action: kept \? 'return' : 'scrap'/);
});

test('return verification locks peers the same way the queue lists them', () => {
  // Regression: the peer query used a plain JOIN LATERAL while /plates/returns and the
  // single-asset fetch both use LEFT. A returned plate whose 'returned' movement is
  // missing then appeared on the card but could never be acted on.
  const route = read('server/src/routes/plates.js');
  const peers = route.slice(route.indexOf('const peers = await qc('));
  const query = peers.slice(0, peers.indexOf('FOR UPDATE OF pa'));
  assert.match(query, /LEFT JOIN LATERAL/);
  assert.doesNotMatch(query, /plate_assets pa JOIN LATERAL/);
});

test('the operator picks each returned plate a condition, not a fixed chip', () => {
  const section = read('client/src/pages/Section.jsx');
  // The dead "Return queue" chip used to sit where the control belongs.
  assert.doesNotMatch(section, /Return queue<\/span>/);
  assert.match(section, /PLATE_RETURN_CONDITIONS/);
  // The row's own choice is what the payload carries, per asset.
  assert.match(section, /choice\.condition/);
});

test('the grading is a traffic light with the state written under each colour', () => {
  const section = read('client/src/pages/Section.jsx');
  const sections = read('client/src/sections.js');
  // Tone per state, and the word rendered beneath the dot — colour alone is a
  // guess for anyone who cannot separate the hues.
  assert.match(sections, /PLATE_CONDITION_TONES/);
  for (const [state, hue] of [['Good', 'emerald'], ['Fair', 'amber'], ['Damaged', 'red']]) {
    const block = sections.slice(sections.indexOf(`${state}:`), sections.indexOf(`${state}:`) + 200);
    assert.match(block, new RegExp(hue), `${state} should read ${hue}`);
  }
  assert.match(section, /rounded-full \$\{tone\.dot\}/);
  assert.match(section, /aria-pressed=\{active\}/);
});

test('unticking a plate scraps it instead of queueing it for verification', () => {
  const section = read('client/src/pages/Section.jsx');
  const plates = read('server/src/plates.js');
  const lifecycle = read('server/src/plate-lifecycle.js');
  assert.match(section, /type="checkbox" checked=\{kept\}/);
  assert.match(section, /action: kept \? 'return' : 'scrap'/);
  assert.match(plates, /new Set\(\['return', 'lost', 'scrap'\]\)/);
  assert.match(lifecycle, /scrapped \? 'scrapped'/);
  // A scrapped plate leaves the active pool rather than lingering as stock.
  assert.match(lifecycle, /IN \('lost','scrapped'\) THEN 0/);
});

test('a Damaged plate cannot be submitted from the form without a note', () => {
  const section = read('client/src/pages/Section.jsx');
  // Mirrors the form's existing rule that scrap demands a reason.
  assert.match(section, /plateDispositionsIncomplete/);
});

test('the returned condition is what gets written to the asset and its movement', () => {
  const lifecycle = read('server/src/plate-lifecycle.js');
  assert.doesNotMatch(lifecycle, /const condition = asset\.condition \|\| 'Good'/);
  assert.match(lifecycle, /decision\.condition/);
});

test('the returns queue and its verification lock share one set key', () => {
  const route = read('server/src/routes/plates.js');
  const matches = route.match(/plateReturnSetKey/g) || [];
  assert.ok(matches.length >= 2, `expected the shared key at both sites, saw ${matches.length}`);
  // The peer lock narrows through the same key rather than a second SQL clause, so
  // the card you click and the rows it acts on cannot drift apart.
  assert.match(route, /plateReturnSetKey\(asset\)/);
});

test('the returns queue shows the warehouse what the press declared', () => {
  // Splitting a mixed set into two cards is only useful if the cards say WHY they
  // differ — otherwise they read as one queue listed twice.
  const page = read('client/src/components/PlatesLifecycle.jsx');
  const columns = page.slice(page.indexOf('const returnColumns'), page.indexOf('const historyColumns'));
  assert.match(columns, /key: 'condition'/);
  assert.match(columns, /operator_note/);
});

test('the press can raise a plate replacement from the running row', () => {
  const section = read('client/src/pages/Section.jsx');
  const sections = read('client/src/sections.js');
  const route = read('server/src/routes/plates.js');
  // Row-level action, beside Extra sheets, printing only.
  assert.match(section, /label: 'Replace a plate'/);
  assert.match(section, /openPlateReplacement\(r\)/);
  assert.match(section, /plate-replacement`/);
  // Reason is required and lives in one place per side.
  assert.match(sections, /PLATE_REPLACEMENT_REASONS/);
  assert.match(route, /validatePlateReplacementRequest\(/);
  // The plate leaves the run rather than lingering as issued.
  assert.match(route, /UPDATE plate_assets SET status='damaged',condition='Damaged'/);
  assert.match(route, /status='replacement_required'/);
});

test('a plate replacement rings management, planning, the press and CTP', () => {
  const route = read('server/src/routes/plates.js');
  const categories = read('server/src/notify-categories.js');
  assert.match(route, /plateReplacementRecipients\(users, req\.user\.id\)/);
  assert.match(route, /kind: 'plate_replacement'/);
  // Every kind must be categorised or the notifications guard fails the build.
  assert.match(categories, /plate_replacement: 'alerts'/);
});

test('return verification decides each plate and shows its age', () => {
  const page = read('client/src/components/PlatesLifecycle.jsx');
  const route = read('server/src/routes/plates.js');
  // A checkbox per plate, its run count beside it, and the decisions posted as a list.
  assert.match(page, /aria-label=\{`Keep \$\{row\.component_label\}`\}/);
  assert.match(page, /Number\(row\.use_count\) \|\| 0/);
  assert.match(page, /decisions: plates\.map/);
  assert.match(route, /validateReturnVerification\(\{/);
  // The old whole-set call must keep working for anything that still sends it.
  assert.match(route, /: setRows\.map\(row => \(\{ asset_id: row\.id, action \}\)\)/);
});

test('rack reuse proposes the least-worn plate, not the most recently touched', () => {
  const lifecycle = read('server/src/plate-lifecycle.js');
  const order = lifecycle.slice(lifecycle.indexOf('async function bestPlateCandidate'));
  const clause = order.slice(order.indexOf('ORDER BY'), order.indexOf('LIMIT 1'));
  // Condition is the first question: a Good plate ALWAYS beats a Fair one, however
  // many runs each has had. Wear then orders within a condition, so the least-worn
  // Good plate is proposed. Leading with verified_at (the original) handed out
  // whichever plate had been looked at most recently — unrelated to either.
  assert.match(clause, /^ORDER BY CASE pa\.condition WHEN 'Good' THEN 0 ELSE 1 END/);
  assert.doesNotMatch(clause, /^ORDER BY pa\.verified_at/);
  assert.match(clause, /pa\.use_count ASC/);
});

test('plate age is visible wherever a plate is chosen or handled', () => {
  const page = read('client/src/components/PlatesLifecycle.jsx');
  const section = read('client/src/pages/Section.jsx');
  const route = read('server/src/routes/plates.js');
  // Age travels per component, not just as the set's worst case.
  assert.match(route, /use_count: Number\(row\.use_count\) \|\| 0/);
  // The rack reuse decision, the warehouse list, the returns queue, and the mid-run
  // replacement picker all state how many runs the plate has had.
  assert.match(page, /used \{component\.proposed_use_count \|\| 0\} times/);
  assert.match(page, /key: 'use_count', label: 'Uses'/);
  assert.match(section, /used \{asset\.use_count \|\| 0\} times/);
});

test('accepting a return preserves what the press declared', () => {
  const route = read('server/src/routes/plates.js');
  assert.doesNotMatch(route, /const condition = action === 'verified_ok' \? 'Good' : 'Scrapped'/);
});

test('Plates still exposes all six operational views, grouped into four stages', () => {
  const page = read('client/src/components/PlatesLifecycle.jsx');
  // All six views survive — buying a plate is simply no longer three separate
  // destinations, because raising the need, ordering it and receiving it are one
  // job done by one person. The rack, the press returns and the archive stay apart.
  for (const label of ['Requirement / PR','Purchase Orders','GRN','Plates Warehouse','Return from Printing','History']) {
    assert.ok(page.includes(label), `${label} is missing`);
  }
  assert.match(page, /const PROCUREMENT_TABS = \['requirements', 'pos', 'grns'\]/);
  assert.match(page, /PLATE_STAGES\.map\(stage =>/);
  // Each stage carries a tone, so the rail reads as four places rather than a row
  // of identical pills.
  for (const dot of ['bg-violet-500', 'bg-sky-500', 'bg-amber-500', 'bg-slate-400']) {
    assert.ok(page.includes(dot), `${dot} stage colour is missing`);
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
  const tooling = read('server/src/routes/tooling.js');
  const route = read('server/src/routes/plates.js');
  const page = read('client/src/components/PlatesLifecycle.jsx');
  // Raised by hand in Tooling now — production.js no longer auto-creates one
  // (see 'the plant flow does not consult the plate warehouse').
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
  // The approval filter is suppressed on the Converted view — a converted PR has no
  // approval question left. Asserted as the RULE, not as the widget that renders it.
  assert.match(page, /\{reqView !== 'converted' && \(/);
  assert.match(page, /setApprovalView\(option\.key\)/);
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
  // Both destinations are still offered at verification — now as a per-plate tick
  // rather than two buttons that decided the whole set at once.
  assert.match(page, /'Used Rack' : 'Scrap'/);
  assert.match(page, /action: keep\[row\.asset_id\] \? 'verified_ok' : 'scrap'/);
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

test('an unready plate set cannot hold an order line back from ready', () => {
  const helpers = read('server/src/helpers.js');
  // toolingGateOk() fails a soft family on an explicit 'not_ready', and
  // orders.js gates planned → ready on gate.tooling — so a Plate Set folded
  // into the tooling detail blocked the line silently. It stays out.
  assert.doesNotMatch(helpers, /family: 'plate', label: 'Plate Set'/);
  assert.doesNotMatch(helpers, /ctx\.plates/);
});

test('a structured refusal no caller renders still reaches the user', () => {
  const api = read('client/src/api.js');
  // The blanket "any code means someone drew a modal" rule is what made the
  // refusal invisible. Suppression must be opt-in per code, so a new server
  // code that nobody wired up degrades to a visible toast, never to silence.
  assert.doesNotMatch(api, /if \(!data\.code\) onError\(msg\)/);
  // The opt-in was a bare Set with the handler named in a trailing comment,
  // and the comments went stale — two board codes were filed under a component
  // that calls neither of their routes. The set is now DERIVED from HANDLED_BY,
  // so a code cannot be silenced without a claim, and handled-codes.test.js
  // holds every claim to a file that really says the refusal.
  assert.match(api, /HANDLED_CODES = new Set\(Object\.keys\(HANDLED_BY\)\)/);
  // Both exits — request() and upload() — must consult the list, or half the
  // app keeps the old silent behaviour.
  assert.equal((api.match(/HANDLED_CODES\.has\(data\.code\)/g) || []).length, 2);
  // The gate that started this must be on the list AND have its dialog, which
  // is the pairing the previous test proves for all three pages.
  assert.match(api, /'PLATES_NOT_READY'/);
});
