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
  // NOT auto_from_finalise — the finalise no longer raises a Plate PR at all;
  // see plates-never-block.test.js for the negative guard that keeps it that way.
  assert.match(route, /plateReadinessForPrinting\(qc, jc\.id/);
  assert.match(route, /issuePlateAssetsForJob\(qc, oc, jc, machineId/);
  assert.match(route, /applyPlateDispositions\(qc, oc, st\.id, req\.body\.plate_dispositions/);
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

test('a plate count that disagrees with the ticks warns, it does not disable Complete', () => {
  const section = read('client/src/pages/Section.jsx');
  // A disabled Complete button is a hard blocker wherever it sits, and plates may
  // not have one: a press that has finished its run has finished it, and refusing
  // the click only means the SHEET count goes unrecorded as well.
  assert.match(section, /plateCountDisagrees/, 'the mismatch should still be detected');
  assert.doesNotMatch(section, /plateDispositionsIncomplete/, 'and must not gate the button');
  // The one legitimate wait: the issued list must have arrived, or the form would
  // post an empty account of a job that did have plates.
  assert.match(section, /section === 'printing' && plateDisposition\.loading/);
  // The mismatch is still SAID, in the amber note beside the count.
  assert.match(section, /plates are marked as coming back, but you have typed/);
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
  // The ordering lives in PLATE_CANDIDATE_ORDER_SQL now — plateCandidates
  // interpolates it, and so does the register's availability ranking, so the
  // picker and the wear a row reports can never order the shelf differently.
  const at = lifecycle.indexOf('export const PLATE_CANDIDATE_ORDER_SQL');
  assert.ok(at > 0, 'PLATE_CANDIDATE_ORDER_SQL not found — the anchor moved');
  const clause = lifecycle.slice(at, lifecycle.indexOf('`;', at));
  // Condition is the first question: a Good plate ALWAYS beats a Fair one, however
  // many runs each has had. Wear then orders within a condition, so the least-worn
  // Good plate is proposed. Leading with verified_at (the original) handed out
  // whichever plate had been looked at most recently — unrelated to either.
  assert.match(clause, /CASE pa\.condition WHEN 'Good' THEN 0 ELSE 1 END/);
  assert.doesNotMatch(clause, /verified_at/);
  assert.match(clause, /pa\.use_count ASC/);
  const candidates = lifecycle.slice(lifecycle.indexOf('async function plateCandidates'));
  assert.match(candidates.slice(0, candidates.indexOf('${limitSql}')),
    /ORDER BY \$\{PLATE_CANDIDATE_ORDER_SQL\}/);
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

test('a Plate PR can be approved and unapproved from its row, not only from the modal', () => {
  const page = read('client/src/components/PlatesLifecycle.jsx');
  const route = read('server/src/routes/plates.js');
  // Both buttons on the row itself, guarded by the same predicates the server uses.
  assert.match(page, /canApproveRow\(row\) && <Button size="sm" variant="success"/);
  assert.match(page, /canUnapproveRow\(row\) && <Button size="sm"/);
  // Approve from a DRAFT row is two writes and one gesture: a draft carries no
  // size, so it must be saved before the route will look at it.
  assert.match(page, /const saveRowDraft = async row =>/);
  assert.match(page, /api\.put\(`\/plates\/requirements\/\$\{row\.id\}`, draft\)/);
  // Unapprove keeps the reason dialog the modal already used — the server 400s
  // without one, so a bare button would be a guaranteed refusal.
  assert.match(page, /kind:'unapprove',row,[\s\S]{0,120}requireReason:true/);
  assert.match(route, /Record why this Plate PR is being unapproved/);
});

test('the row button, the bulk bar and the modal all approve through one function', () => {
  const page = read('client/src/components/PlatesLifecycle.jsx');
  assert.equal((page.match(/async function approvePlateRequest\(/g) || []).length, 1);
  // Three callers, one spelling. The modal used to hold its own copy.
  assert.ok((page.match(/approvePlateRequest\(\{/g) || []).length >= 3,
    'row, bulk and modal should all route through approvePlateRequest');
  // The ids MUST come from what the save wrote: PUT rebuilds components when the
  // structure changes, so ids read before the save can already be dead.
  const fn = page.slice(page.indexOf('async function approvePlateRequest('));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /const fresh = request\.approval_status === 'approved' \? request : await save\(\)/);
  assert.match(body, /approvableComponents\(fresh\.components\)/);
});

test('the approval rules are one rule, asked by the route and by the button', () => {
  const plates = read('server/src/plates.js');
  const route = read('server/src/routes/plates.js');
  const page = read('client/src/components/PlatesLifecycle.jsx');
  // The server owns them…
  assert.match(plates, /export const APPROVABLE_COMPONENT_STATUSES/);
  assert.match(plates, /export function canApprovePlateRequest/);
  assert.match(plates, /export function canUnapprovePlateRequest/);
  // …and USES them, or they are decoration that can drift from the real guard.
  assert.match(route, /APPROVABLE_COMPONENT_STATUSES\.includes\(component\.status\)/);
  assert.match(route, /canUnapprovePlateRequest\(\{ \.\.\.request, components \}\)/);
  // The client mirrors the same three statuses. Compared as a SET, so reordering
  // one side is not a failure but dropping or adding a status is.
  const listOf = (text, name) => {
    const at = text.indexOf(name);
    return [...text.slice(at, text.indexOf(']', at)).matchAll(/'([a-z_]+)'/g)].map(m => m[1]).sort();
  };
  assert.deepEqual(listOf(page, 'const APPROVABLE_COMPONENT_STATUSES'),
    listOf(plates, 'export const APPROVABLE_COMPONENT_STATUSES'),
    'the client mirror and the server rule must list the same statuses');
});

test('every plate screen names the job by its output number, in its own column', () => {
  // The output (plate / positive) number is what the plant calls a job by, and
  // the plate module is where the number IS the subject — a rack of aluminium is
  // sorted and searched by it. All six views carry it as a keyed column.
  const page = read('client/src/components/PlatesLifecycle.jsx');
  const columnSets = ['requestColumns', 'poColumns', 'grnColumns', 'warehouseColumns', 'returnColumns', 'historyColumns'];
  for (const name of columnSets) {
    const at = page.indexOf(`const ${name} = [`);
    assert.ok(at > 0, `${name} is missing`);
    const block = page.slice(at, page.indexOf('\n  ];', at));
    assert.match(block, /\{ key: 'output_number', label: 'Output'/, `${name} has no dedicated Output column`);
  }
  // The rack showed it INSIDE the artwork cell, so the column sorted and searched
  // on artwork_version while displaying the output number above it — the number
  // could not be ordered or found at all.
  assert.doesNotMatch(page, /label: 'Output \/ Artwork'/);
  // A PO carries several plate sets, so its column sorts on a real scalar rather
  // than on the rendered join.
  const po = page.slice(page.indexOf('const poColumns = ['));
  assert.match(po.slice(0, po.indexOf('\n  ];')), /sortValue: row =>/);
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
  // The plate module's screen and the identity vocabulary it renders with. The
  // gang wording used to live inside PlatesLifecycle.jsx; it moved to
  // plateIdentity.jsx so the PO edit modal, the register and the PRINTED
  // purchase order could say it too. The rule is that the plant sees it — not
  // which file holds the string — so both are read.
  const page = read('client/src/components/PlatesLifecycle.jsx')
    + read('client/src/components/plateIdentity.jsx');
  // ONE gang prints from ONE plate set, so a gang's plate demand must be raised
  // as a single unified requirement rather than one per member. The rule now
  // lives only in the MANUAL door (tooling.js): the Job Card finalise no longer
  // raises plates at all, so production.js has no plate request path to hold it.
  assert.match(tooling, /gangPlateSpecification\(gang, targets\)/);
  assert.match(route, /tr\.specification->>'output_number'/);
  for (const label of ['Unified gang plate','Gang members','All approvals','Approved','Unapproved','Output']) {
    assert.ok(page.includes(label), `${label} is missing`);
  }
  // A vocabulary nothing imports is a vocabulary nobody sees. Pin the wiring so
  // the strings above cannot pass by sitting in an orphaned module.
  assert.match(read('client/src/components/PlatesLifecycle.jsx'),
    /from '\.\/plateIdentity\.jsx'/,
    'PlatesLifecycle must render through the shared plate identity, or the screens will drift apart again');
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

// ── Plates inform the plant flow; they never refuse it ────────────────────
// The gate shipped as a structured 409 and reached nobody: api.js suppresses the
// central toast for any error carrying a `code`, on the convention that the
// caller draws a modal, and nothing drew one — so Start Run did nothing at all,
// no toast, no dialog, no reason, on all three pages that start a printing
// stage. The gate is gone now on Anik's explicit instruction: a plate may never
// stand between a press and its run. What is left is a record.

test('the server cannot refuse a printing start over plates', () => {
  const route = read('server/src/routes/production.js');
  const lifecycle = read('server/src/plate-lifecycle.js');
  // The refusal and the acknowledgement that answered it are both gone.
  assert.doesNotMatch(route, /assertPlateReadyForPrinting/);
  assert.doesNotMatch(route, /ack_plates/);
  assert.doesNotMatch(lifecycle, /PLATES_NOT_READY/);
  // Nothing in the whole lifecycle throws — the module reports and writes.
  assert.doesNotMatch(lifecycle, /throw /);
});

test('a start that goes ahead short of plates says so on the record', () => {
  // Soft does not mean silent. The audit names what was missing so the shortage
  // is answerable afterwards, which is the whole value the refusal never delivered.
  const route = read('server/src/routes/production.js');
  assert.match(route, /plates_short_at_start/);
  assert.match(route, /missing \$\{/);
});

test('the client keeps its refusal dialog so a re-added gate is never silent again', () => {
  // Dead while the server refuses nothing — and deliberately kept. If anyone ever
  // puts a plate gate back, the pages already answer it; deleting this is how the
  // silent Start Run button comes back.
  for (const path of ['client/src/pages/Section.jsx', 'client/src/pages/Floor.jsx', 'client/src/pages/Production.jsx']) {
    assert.match(read(path), /PLATES_NOT_READY/, `${path} would swallow a plate refusal`);
  }
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
