// Taking a rack plate out of circulation, putting it back, and undoing the first.
//
// Set aside changes STATUS ONLY. condition is a physical grade produced by
// inspecting the plate — the return-verification flow does that. A planner
// flagging a plate from the picker has not inspected it, and the status
// 'damaged' already says what they mean. Writing condition='Damaged' there would
// be the system asserting a grade nobody checked; it is also what would make
// Undo impossible, since plate_asset_movements records only the RESULTING
// condition and has no from_condition to restore.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PLATE_SET_ASIDE_REASONS, PLATE_RETIRE_REASONS } from '../../client/src/lib/plateRack.js';
import {
  validateSetAside, validateMakeAvailable, PLATE_RESTORABLE_STATUSES, invertMovement,
} from './plates.js';

const root = new URL('../../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');

test('every set-aside reason names a status the database already allows', () => {
  // Exactly the four in the spec, in offer order.
  assert.deepEqual(PLATE_SET_ASIDE_REASONS.map(row => row.key),
    ['damaged', 'missing', 'check', 'other']);
  // Live CHECK constraints, verified against production before this was designed.
  const STATUSES = ['damaged', 'lost', 'awaiting_verification'];
  const ACTIONS = ['damaged', 'not_found', 'verification_requested'];
  for (const row of PLATE_SET_ASIDE_REASONS) {
    assert.ok(row.label, `${row.key} needs a label the planner can read`);
    assert.ok(STATUSES.includes(row.status), `${row.key} → ${row.status} is not an allowed status`);
    assert.ok(ACTIONS.includes(row.action), `${row.key} → ${row.action} is not an allowed movement action`);
    // No reason may re-grade the plate. See the header.
    assert.ok(!('condition' in row), `${row.key} must not set a condition`);
  }
});

test('set-aside reasons are not the retire reasons', () => {
  // Retire asks why a plate is DEAD ("Worn out — dot loss", "Artwork changed").
  // Set aside asks why it is off the rack TODAY. Sharing the list would offer
  // "Artwork changed" as a temporary state and "Can't find it" as a scrap reason.
  // Damaged and Other are the only labels that may coincide, and neither is a
  // shared REASON: Damaged is the one physical state both questions can have an
  // answer to, and Other is the free-text escape hatch every such dialog offers.
  // Every substantive reason stays on its own side.
  const retire = new Set(PLATE_RETIRE_REASONS);
  const overlap = PLATE_SET_ASIDE_REASONS.filter(row => retire.has(row.label));
  assert.deepEqual(overlap.map(row => row.label), ['Damaged', 'Other'],
    'only Damaged and the Other escape hatch legitimately appear in both lists');
});

test('the reason table has one home, and the server reads it from there', () => {
  const plates = read('server/src/plates.js');
  assert.match(plates, /from '\.\.\/\.\.\/client\/src\/lib\/plateRack\.js'/);
  assert.match(plates, /PLATE_SET_ASIDE_REASONS/);
  // Not re-declared server-side — a twin is a thing to keep in step.
  assert.doesNotMatch(plates, /const PLATE_SET_ASIDE_REASONS\s*=\s*\[/);
});

const plate = (id, extra = {}) => ({
  id, asset_number: `CI-PL-A-${String(id).padStart(4, '0')}`,
  status: extra.status || 'available', condition: extra.condition || 'Good',
  rack_location: extra.rack_location || 'Used Plates Rack',
});

test('setting a plate aside resolves the reason to a status and an action', () => {
  const out = validateSetAside({ rackAssets: [plate(1)], assetIds: [1], reason: 'damaged' });
  assert.deepEqual(out.picked.map(row => row.id), [1]);
  assert.equal(out.rule.status, 'damaged');
  assert.equal(out.rule.action, 'damaged');
});

test('an unknown or missing reason is refused before anything is touched', () => {
  for (const reason of [undefined, '', 'nonsense', 'Damaged']) {
    assert.throws(() => validateSetAside({ rackAssets: [plate(1)], assetIds: [1], reason }),
      error => error.status === 400,
      `reason ${JSON.stringify(reason)} should be refused — the table is keyed by key, not label`);
  }
});

// The rule that protects the floor. Setting aside a plate a job card is relying
// on strands that job silently, so it uses the SAME guard Retire uses rather
// than re-spelling it.
test('a plate a job owns can never be set aside, and the refusal names it', () => {
  for (const status of ['reserved', 'issued_to_printing', 'returned_pending_verification']) {
    assert.throws(() => validateSetAside({
      rackAssets: [plate(1, { status })], assetIds: [1], reason: 'damaged',
    }), error => error.status === 409 && /CI-PL-A-0001/.test(error.message),
    `${status} must be refused by name`);
  }
});

test('a plate that is not on this rack at all is refused', () => {
  assert.throws(() => validateSetAside({ rackAssets: [plate(1)], assetIds: [99], reason: 'damaged' }),
    error => error.status === 409);
});

test('set aside goes through the same guard as retire, not a second spelling', () => {
  const plates = read('server/src/plates.js');
  const fn = plates.slice(plates.indexOf('export function validateSetAside'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.ok(body.length > 100, 'validateSetAside not found — the anchor moved');
  assert.match(body, /pickAvailableRackPlates\(/);
  // No hand-rolled copy of the in-flight rule.
  assert.doesNotMatch(body, /issued_to_printing/);
});

test('a set-aside plate comes back with the condition the planner stated', () => {
  const out = validateMakeAvailable({
    rackAssets: [plate(1, { status: 'damaged' })], assetIds: [1], condition: 'Fair',
  });
  assert.deepEqual(out.map(row => row.id), [1]);
});

test('every set-aside state and scrapped can be restored', () => {
  assert.deepEqual(PLATE_RESTORABLE_STATUSES,
    ['damaged', 'lost', 'awaiting_verification', 'scrapped']);
  for (const status of PLATE_RESTORABLE_STATUSES) {
    const out = validateMakeAvailable({
      rackAssets: [plate(1, { status })], assetIds: [1], condition: 'Good',
    });
    assert.equal(out.length, 1, `${status} should be restorable`);
  }
});

// A plate whose condition reads 'Scrapped' must not come back as Good because
// nobody chose. There is no default here on purpose.
test('bringing a plate back without stating its condition is refused', () => {
  for (const condition of [undefined, '', 'Good ', 'Damaged', 'Scrapped']) {
    assert.throws(() => validateMakeAvailable({
      rackAssets: [plate(1, { status: 'scrapped' })], assetIds: [1], condition,
    }), error => error.status === 400,
    `condition ${JSON.stringify(condition)} should be refused — only Good or Fair`);
  }
});

test('a plate already on the rack, or in flight, is not restorable', () => {
  for (const status of ['available', 'reserved', 'issued_to_printing']) {
    assert.throws(() => validateMakeAvailable({
      rackAssets: [plate(1, { status })], assetIds: [1], condition: 'Good',
    }), error => error.status === 409 && /CI-PL-A-0001/.test(error.message),
    `${status} must be refused by name`);
  }
});

test('restoring nothing is refused rather than reported as success', () => {
  assert.throws(() => validateMakeAvailable({ rackAssets: [plate(1)], assetIds: [], condition: 'Good' }),
    error => error.status === 400);
});

const movement = (extra = {}) => ({
  id: 7, plate_asset_id: 1, action: 'damaged',
  from_status: 'available', to_status: 'damaged',
  from_location: 'Used Plates Rack', to_location: 'Used Plates Rack',
  tooling_request_id: null, job_card_id: null, ...extra,
});

test('undoing a set-aside restores where the plate was, and nothing else', () => {
  const out = invertMovement({
    movement: movement(), asset: plate(1, { status: 'damaged' }),
  });
  assert.equal(out.status, 'available');
  assert.equal(out.rack_location, 'Used Plates Rack');
  assert.equal(out.active, 1);
  // Set aside never changed the grade, so undo has nothing to put back — and the
  // movements table has no from_condition it could read anyway.
  assert.ok(!('condition' in out), 'undo must not write a condition');
});

// action alone cannot tell these apart: releaseDraftPlateAssets writes
// 'adjustment' too, and so do the PR edit and delete paths. Reversing one of
// those here would re-reserve a plate against a job that no longer wants it.
test('a movement belonging to a job card is not undoable here', () => {
  for (const extra of [{ tooling_request_id: 5 }, { job_card_id: 9 }]) {
    assert.throws(() => invertMovement({
      movement: movement({ action: 'adjustment', ...extra }),
      asset: plate(1, { status: 'damaged' }),
    }), error => error.status === 409 && error.body.code === 'MOVEMENT_NOT_UNDOABLE');
  }
});

test('only the three set-aside actions can be undone', () => {
  for (const action of ['damaged', 'not_found', 'verification_requested']) {
    const out = invertMovement({
      movement: movement({ action, to_status: 'damaged' }),
      asset: plate(1, { status: 'damaged' }),
    });
    assert.equal(out.status, 'available', `${action} should be undoable`);
  }
  // 'scrapped' is reversed by Return to rack, which asks for the condition;
  // 'adjustment' and 'reserved' belong to other flows entirely.
  for (const action of ['scrapped', 'adjustment', 'reserved', 'issued', 'returned']) {
    assert.throws(() => invertMovement({
      movement: movement({ action }), asset: plate(1, { status: 'damaged' }),
    }), error => error.status === 409 && error.body.code === 'MOVEMENT_NOT_UNDOABLE',
    `${action} must not be undoable here`);
  }
});

test('a plate that has moved on since is refused by name, not overwritten', () => {
  assert.throws(() => invertMovement({
    movement: movement(),                       // left the plate at 'damaged'
    asset: plate(1, { status: 'reserved' }),    // but it is reserved now
  }), error => error.status === 409
    && error.body.code === 'MOVEMENT_SUPERSEDED'
    && /CI-PL-A-0001/.test(error.message)
    && /reserved/.test(error.message));
});

test('undoing a movement whose record is gone is refused', () => {
  assert.throws(() => invertMovement({ movement: null, asset: plate(1) }),
    error => error.status === 404);
  assert.throws(() => invertMovement({ movement: movement(), asset: null }),
    error => error.status === 404);
});

const routeBody = (route, start, end) => {
  const fn = route.slice(route.indexOf(start));
  return fn.slice(0, end ? fn.indexOf(end) : undefined);
};

test('set aside writes status only, and never a condition', () => {
  const route = read('server/src/routes/plates.js');
  const body = routeBody(route, "r.post('/plates/assets/set-aside'", "\nr.post('/plates/assets/make-available'");
  assert.ok(body.length > 400, 'set-aside route not found — the anchor moved');
  assert.match(body.slice(0, 120), /set-aside', canVerify/);
  assert.match(body, /validateSetAside\(/);
  // Status only. Re-grading a plate nobody inspected is what this must not do.
  assert.doesNotMatch(body, /SET status=\$1,condition=/);
  assert.match(body, /movement_ids/);
});

test('make available clears active so an un-retired plate is really back', () => {
  const route = read('server/src/routes/plates.js');
  const body = routeBody(route, "r.post('/plates/assets/make-available'", "\nr.post('/plates/assets/undo-movement'");
  assert.ok(body.length > 400, 'make-available route not found — the anchor moved');
  assert.match(body.slice(0, 130), /make-available', canVerify/);
  assert.match(body, /validateMakeAvailable\(/);
  // A scrapped plate carries active=0 and rack 'Scrap'; both have to be undone
  // or the plate is "available" and still invisible to every rack query.
  assert.match(body, /active=1/);
  assert.match(body, /USED_PLATES_RACK/);
});

test('undo refuses by name and says so in a code the page can read', () => {
  const route = read('server/src/routes/plates.js');
  const body = routeBody(route, "r.post('/plates/assets/undo-movement'", "\nr.get('/plates/sets/history'");
  assert.ok(body.length > 300, 'undo-movement route not found — the anchor moved');
  assert.match(body.slice(0, 130), /undo-movement', canVerify/);
  assert.match(body, /invertMovement\(/);
  assert.match(body, /FOR UPDATE/);
  // Undo is an event in the ledger, never an erasure of one.
  assert.match(body, /INSERT INTO plate_asset_movements/);
});

// Production's pool is max: 1, so a module-level q() issued while a transaction
// holds the only client waits for itself for ever.
test('the three new routes read on the transaction client, never the pool', () => {
  const route = read('server/src/routes/plates.js');
  for (const [start, end] of [
    ["r.post('/plates/assets/set-aside'", "\nr.post('/plates/assets/make-available'"],
    ["r.post('/plates/assets/make-available'", "\nr.post('/plates/assets/undo-movement'"],
    ["r.post('/plates/assets/undo-movement'", "\nr.get('/plates/sets/history'"],
  ]) {
    const body = routeBody(route, start, end);
    assert.ok(body.length > 300, `${start} not found — the anchor moved`);
    assert.doesNotMatch(body, /await q\(/, `${start} must not use the pool inside tx`);
  }
});

// The state that would do real damage, pinned.
//
// releaseDraftPlateAssets writes action='adjustment' with a tooling_request_id
// and a job_card_id — but BOTH columns are ON DELETE SET NULL, and both parents
// get deleted for real (deletePlateRequirements drops the request; job cards are
// deleted in workflow.js and gangs.js, cascading the request away). So a
// released-plate row with both ids NULL is reachable, and the id guard does
// nothing for it. Only the action list stands between that row and undo
// re-reserving a plate against a job that no longer exists.
test('a released-plate movement stripped of its job ids is still not undoable', () => {
  assert.throws(() => invertMovement({
    movement: {
      id: 41, plate_asset_id: 1, action: 'adjustment',
      from_status: 'reserved', to_status: 'available',
      from_location: 'Used Plates Rack', to_location: 'Used Plates Rack',
      tooling_request_id: null, job_card_id: null,   // parents deleted
    },
    asset: plate(1, { status: 'available' }),        // and the plate still matches
  }), error => error.status === 409 && error.body.code === 'MOVEMENT_NOT_UNDOABLE',
  'undoing this would re-reserve the plate against a job that no longer exists');
});

// The complement: the PR verification flow writes the very actions this undoes,
// WITH job links. plate-lifecycle.js:177 writes 'verification_requested' with
// from_status === to_status, so it clears both the action guard and the
// superseded guard — the id check is the only thing that catches it.
test('a verification movement is refused by the id guard, not the action guard', () => {
  assert.throws(() => invertMovement({
    movement: {
      id: 42, plate_asset_id: 1, action: 'verification_requested',
      from_status: 'available', to_status: 'available',   // clears the superseded check
      from_location: 'Used Plates Rack', to_location: 'Used Plates Rack',
      tooling_request_id: 5, job_card_id: 9,
    },
    asset: plate(1, { status: 'available' }),
  }), error => error.status === 409 && error.body.code === 'MOVEMENT_NOT_UNDOABLE');
});

// The refusal has to name the PLATE. component_label is NOT NULL on
// plate_assets, so leading with it meant the asset number was never reached and
// every refusal read "cyan is not available" — useless on a set with two cyans,
// because it does not say which plate to go and look at.
test('a refusal names the plate first, then its colour', () => {
  assert.throws(() => validateSetAside({
    rackAssets: [{ ...plate(1, { status: 'issued_to_printing' }), component_label: 'Cyan' }],
    assetIds: [1], reason: 'damaged',
  }), error => /^CI-PL-A-0001 \(Cyan\) is not available/.test(error.message),
  'the asset number must lead, with the colour in support');
});

// Out of this feature's scope, fixed because it was found while working here.
//
// /plates/components/:id/verify-existing accepts outcome 'scrap', and wrote that
// straight into plate_asset_movements.action — where the CHECK spells it
// 'scrapped'. Clicking Scrap on a returned plate therefore violated the
// constraint, 500'd, and rolled the whole verification back, leaving the plate
// in limbo. The status mapping beside it was already correct; only the action
// was not.
test('a verification outcome is translated into the movement vocabulary', () => {
  const route = read('server/src/routes/plates.js');
  const fn = route.slice(route.indexOf("r.post('/plates/components/:id/verify-existing'"));
  const body = fn.slice(0, fn.indexOf('\nr.post('));
  assert.ok(body.length > 500, 'verify-existing route not found — the anchor moved');
  // Every outcome that reaches the INSERT must be an allowed action.
  assert.match(body, /outcome === 'scrap' \? 'scrapped'/);
  const ALLOWED = ['received', 'verification_requested', 'verified', 'reserved', 'issued',
    'returned', 'damaged', 'scrapped', 'not_found', 'replacement_required',
    'location_changed', 'adjustment', 'reversed'];
  // 'usable' never reaches this branch, 'replacement' and 'scrap' are translated.
  for (const outcome of ['not_found', 'damaged']) {
    assert.ok(ALLOWED.includes(outcome), `${outcome} passes through and must be a legal action`);
  }
});

test('the picker can take a plate off the rack, but not the one the line holds', () => {
  const modal = read('client/src/components/RackPickerModal.jsx');
  assert.match(modal, /PLATE_SET_ASIDE_REASONS/);
  // The row flagged current is the plate this line already holds, and it is
  // 'reserved' — offering Set aside there walks the planner into the in-flight
  // guard for a 409 they could have been spared.
  assert.match(modal, /!row\.current/);
  // The modal decides nothing: the reason table is the tested lib's job.
  assert.match(modal, /from '\.\.\/lib\/plateRack\.js'/);
  // The key travels, never the label — re-wording a button must not change what it does.
  assert.match(modal, /reason\.key/);
});

test('the warehouse has somewhere for a plate that is off the rack to live', () => {
  const page = read('client/src/components/PlatesLifecycle.jsx');
  // Without this tab a set-aside plate is invisible: Fresh and Used both filter
  // status === 'available', so nothing renders a plate in any other state and
  // there is nowhere to bring one back from.
  assert.match(page, /key:\s*'aside'/);
  assert.match(page, /make-available/);
  assert.match(page, /set-aside/);
});

// A handler that is declared and never called is stripped by the minifier, so a
// test that merely finds the endpoint STRING in the source passes while the
// button ships nowhere. That is exactly what happened here first time round:
// `undo-movement` was present in the file and absent from the built bundle.
// Assert the wiring, not the string.
test('Undo is actually wired to something a planner can press', () => {
  const page = read('client/src/components/PlatesLifecycle.jsx');
  const fn = page.slice(page.indexOf('function AssetHistoryModal'));
  const body = fn.slice(0, fn.indexOf('\nexport default function'));
  assert.ok(body.length > 500, 'AssetHistoryModal not found — the anchor moved');
  // It lives on the movement ledger because that is the only screen carrying a
  // movement id: /plates/warehouse returns plates, grouped into sets.
  assert.match(body, /undo-movement/);
  assert.match(body, /onClick=\{\(\) => undoMovement\(row\.id\)/);
  // Offered only where the server would allow it — mirroring invertMovement, so
  // no button's only possible outcome is a 409.
  assert.match(body, /UNDOABLE_SET_ASIDE_ACTIONS\.includes\(row\.action\)/);
  assert.match(body, /!row\.job_card_id/);
});

test('no plate is in two warehouse tabs, and none is in none', () => {
  const page = read('client/src/components/PlatesLifecycle.jsx');
  const start = page.indexOf('const rackRows');
  const body = page.slice(start, start + 900);
  assert.ok(body.length > 200, 'rackRows not found — the anchor moved');
  // Fresh and Used stay keyed on available; the third tab takes what they exclude.
  assert.match(body, /status === 'available'/);
});
