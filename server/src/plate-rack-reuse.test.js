// "How many of this Plate PR's plates are already on the rack?"
//
// The Requirement page used to answer this ONCE, at the instant the components
// were created: bestPlateCandidate ran, and whatever the rack held at that
// moment was proposed. A plate that came back from the press an hour later was
// invisible for ever after, so the plant bought plates it already owned.
//
// rackReusePlan is the live answer, recomputed on every read. Its one law is
// PARITY: the number the column prints is the number the button will actually
// take. A figure that promises four and delivers two is worse than no figure.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  PLATE_HELD_COMPONENT_STATUSES, RACK_CLAIMABLE_COMPONENT_STATUSES,
  rackReusePlan, plateComponentKey, plateComponentStatus,
  plateArtworkKey, plateArtworkTrailingKey, isBareArtworkRevision,
  nextPlateRequestStatus, resolveRackPicks, releasableRackComponents,
} from './plates.js';
import { defaultPickSelection, duplicatePickAssets, pickPayload } from '../../client/src/lib/plateRack.js';

const root = new URL('../../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');

const component = (component_type, status, extra = {}) => ({
  id: extra.id ?? Math.floor(Math.random() * 1e6),
  component_type,
  component_label: extra.component_label
    || (component_type === 'pantone' ? `Pantone - ${extra.pantone_code}` : component_type),
  pantone_code: extra.pantone_code || null,
  status,
});
const rack = (component_type, available, pantone_code = null) => ({ component_type, pantone_code, available });
const lineFor = (plan, key) => plan.lines.find(row => row.key === key);

test('the rack covers every plate the PR still needs', () => {
  const plan = rackReusePlan({
    components: [component('cyan', 'pr_required'), component('magenta', 'pr_required')],
    available: [rack('cyan', 1), rack('magenta', 1)],
  });
  assert.equal(plan.needed, 2);
  assert.equal(plan.total, 2);
});

test('the total is what the button will take, never what the rack holds', () => {
  // Five Cyan plates on the rack and one Cyan line: the click takes ONE. A column
  // that printed 5 here would promise four plates this PR has no use for.
  const plan = rackReusePlan({
    components: [component('cyan', 'pr_required')],
    available: [rack('cyan', 5)],
  });
  assert.equal(plan.total, 1, 'stock beyond the need must not inflate the offer');
  assert.equal(lineFor(plan, 'cyan|').available, 5, 'the rack figure itself is still reported');
  assert.equal(lineFor(plan, 'cyan|').usable, 1);
});

test('a short rack caps the offer at what is physically there', () => {
  const plan = rackReusePlan({
    components: [component('black', 'pr_required'), component('black', 'pr_required'), component('black', 'pr_required')],
    available: [rack('black', 2)],
  });
  assert.equal(plan.needed, 3);
  assert.equal(plan.total, 2, 'the third plate still has to be bought');
});

test('the total always equals the sum of the lines it is built from', () => {
  // The parity law, asserted as arithmetic rather than as a number: whatever the
  // mix, the headline figure and the per-colour figures must be the same claim.
  const plan = rackReusePlan({
    components: [
      component('cyan', 'pr_required'), component('cyan', 'pr_required'),
      component('magenta', 'verification_required'),
      component('yellow', 'pr_required'),
      component('pantone', 'replacement_required', { pantone_code: '485' }),
    ],
    available: [rack('cyan', 1), rack('magenta', 3), rack('pantone', 2, '485')],
  });
  assert.equal(plan.total, plan.lines.reduce((sum, row) => sum + row.usable, 0));
  assert.equal(plan.total, 1 + 1 + 0 + 1);
  assert.equal(lineFor(plan, 'yellow|').usable, 0, 'nothing on the rack is a zero, not a missing line');
  assert.equal(lineFor(plan, 'yellow|').needed, 1, 'and the need is still stated so the screen can say 0 of 1');
});

test('a plate already proposed but never verified is still claimable', () => {
  // verification_required is the backlog this whole feature exists to clear: a
  // plate the rack offered months ago that nobody ever walked over and confirmed.
  assert.ok(RACK_CLAIMABLE_COMPONENT_STATUSES.includes('verification_required'));
  const plan = rackReusePlan({
    components: [component('cyan', 'verification_required')],
    available: [rack('cyan', 1)],
  });
  assert.equal(plan.total, 1);
});

test('a plate that is bought, in hand or spent is not claimable from the rack', () => {
  // approved/po_created are on their way to a vendor; verified_existing and issued
  // already HAVE their plate. Counting any of them would offer the rack twice.
  for (const status of ['approved', 'po_created', 'ordered', 'grn_received', 'verified_existing', 'issued', 'cancelled']) {
    const plan = rackReusePlan({
      components: [component('cyan', status)],
      available: [rack('cyan', 4)],
    });
    assert.equal(plan.needed, 0, `${status} must not count as a need`);
    assert.equal(plan.total, 0, `${status} must not be offered a rack plate`);
  }
});

test('a Pantone line is only ever covered by its own Pantone', () => {
  const plan = rackReusePlan({
    components: [
      component('pantone', 'pr_required', { pantone_code: '485' }),
      component('pantone', 'pr_required', { pantone_code: '032' }),
    ],
    available: [rack('pantone', 6, '485')],
  });
  assert.equal(plan.total, 1, 'six plates of Pantone 485 cover the 485 line and nothing else');
  assert.equal(lineFor(plan, plateComponentKey({ component_type: 'pantone', pantone_code: '032' })).usable, 0);
});

test('Pantone identity is matched however the rack spells its case', () => {
  const plan = rackReusePlan({
    components: [component('pantone', 'pr_required', { pantone_code: 'Warm Red' })],
    available: [rack('pantone', 1, 'warm red')],
  });
  assert.equal(plan.total, 1);
});

test('a PR with nothing left to claim offers nothing', () => {
  const plan = rackReusePlan({ components: [], available: [] });
  assert.equal(plan.needed, 0);
  assert.equal(plan.total, 0);
  assert.deepEqual(plan.lines, []);
});

test('every line names the components a click would spend', () => {
  // The endpoint is told WHICH components to claim, so the ids must travel with
  // the figure. Sending ids the plan did not count is how a button takes a plate
  // the column never offered.
  const plan = rackReusePlan({
    components: [
      component('cyan', 'pr_required', { id: 11 }),
      component('cyan', 'approved', { id: 12 }),
      component('cyan', 'pr_required', { id: 13 }),
    ],
    available: [rack('cyan', 9)],
  });
  assert.deepEqual(lineFor(plan, 'cyan|').component_ids, [11, 13],
    'the approved component is on its way to a vendor and is not the rack\'s to give');
  assert.equal(plan.total, 2);
});

test('the rack never offers more plates than the PR has components to hold them', () => {
  for (const needed of [1, 3, 7]) {
    const plan = rackReusePlan({
      components: Array.from({ length: needed }, () => component('cyan', 'pr_required')),
      available: [rack('cyan', 99)],
    });
    assert.ok(plan.total <= plan.needed, `${plan.total}/${plan.needed} claims more plates than the PR asked for`);
  }
});

// ── The requirement is mapped to the rack, and the rack is only lent once ──

test('a plate another requirement is holding is not free, however the asset reads', () => {
  // The hole this closes: nothing in the module ever wrote plate_assets.status
  // 'reserved', although releaseDraftPlateAssets had always looked for it. A
  // plate matched through verification therefore stayed 'available' and could be
  // proposed to a second requirement, verified twice, and issued to whichever
  // job reached the press first. Both the picker and the count now ask.
  const lifecycle = read('server/src/plate-lifecycle.js');
  assert.match(lifecycle, /export const PLATE_ALREADY_CLAIMED_SQL/);
  assert.match(lifecycle, /AND NOT \$\{PLATE_ALREADY_CLAIMED_SQL\}/);
  const route = read('server/src/routes/plates.js');
  assert.match(route, /AND NOT \$\{PLATE_ALREADY_CLAIMED_SQL\}/,
    'the availability count must exclude the same plates the picker refuses');
  // The predicate is BUILT from the held-status list rather than re-typed, so a
  // new "this line is holding a plate" state cannot be added to one and not the
  // other.
  assert.match(lifecycle, /PLATE_HELD_COMPONENT_STATUSES\.map/);
  for (const status of PLATE_HELD_COMPONENT_STATUSES) {
    assert.equal(plateComponentStatus(status), 'ready',
      `${status} claims a plate, so it must also read as ready`);
  }
});

test('reuse reserves the plate rather than leaving it on offer', () => {
  const route = read('server/src/routes/plates.js');
  const door = route.slice(route.indexOf("r.post('/plates/requirements/:id/use-from-rack'"));
  const body = door.slice(0, door.indexOf("r.post('/plates/requirements/:id/approve'"));
  assert.match(body, /UPDATE plate_assets SET status='reserved'/);
  assert.match(body, /current_job_card_id=\$1/);
  // The component records the same fact the careful door records, so issuing,
  // releasing and the readiness summary all keep working unchanged.
  assert.match(body, /status='verified_existing'/);
  assert.match(body, /matched_asset_id=\$1/);
  // Signed, and it leaves a movement: an empty rack slot must be answerable.
  assert.match(body, /verified_by=\$2/);
  assert.match(body, /'reserved','available','reserved'/);
  // A colour the rack cannot cover is skipped, never fatal — three of four is
  // three plates nobody has to buy.
  assert.match(body, /if \(!asset\) continue;/);
});

test('the reuse door and the availability count share one claimable vocabulary', () => {
  const route = read('server/src/routes/plates.js');
  assert.match(route, /RACK_CLAIMABLE_COMPONENT_STATUSES/);
  // verification_required is claimable here and deliberately NOT approvable —
  // a plate the rack already offered must never be bought.
  assert.ok(RACK_CLAIMABLE_COMPONENT_STATUSES.includes('verification_required'));
  const plates = read('server/src/plates.js');
  const at = plates.indexOf('export const RACK_CLAIMABLE_COMPONENT_STATUSES');
  assert.match(plates.slice(at, at + 200), /\.\.\.APPROVABLE_COMPONENT_STATUSES/,
    'the claimable list must be derived from the approvable one, not re-typed beside it');
});

test('the Requirement page prints the rack figure at row level and at form level', () => {
  const page = read('client/src/components/PlatesLifecycle.jsx');
  // Row: its own keyed column, so it sorts and is searchable like any other.
  const columns = page.slice(page.indexOf('const requestColumns = ['), page.indexOf('const poColumns = ['));
  assert.match(columns, /\{ key: 'rack_reuse', label: 'On Rack'/);
  assert.match(columns, /sortValue: row => rackTotal\(row\)/);
  // Form: the per-colour line, beside the quantity it would satisfy.
  assert.match(page, /const rack=rackLineFor\(detail,componentKey\(row\)\)/);
  assert.match(page, /\{rack\.usable\} of \{rack\.needed\} on rack/);
  // Both figures come off the server's plan; the screen does no arithmetic of
  // its own, which is what stops the column and the button disagreeing.
  assert.match(page, /const rackTotal = row => Number\(row\?\.rack_reuse\?\.total\) \|\| 0/);
  const route = read('server/src/routes/plates.js');
  // The plan is built once and printed as-is — the same object also feeds
  // plateWearSummary, so the offer a row shows and the wear it warns about
  // describe the same plates.
  assert.match(route, /const rackReuse = rackReusePlan\(\{/);
  assert.match(route, /rack_reuse: rackReuse,/);
});

// Supersedes 'the row, the form and the dock all reuse through one function'.
// That test asserted all three single-PR doors called useFromRack([row]) — the
// design from when the button chose the plate for you. They now open the picker
// instead, so the count it wanted is necessarily zero. The law it was really
// protecting survives, restated: ONE blind path, and it belongs to the dock.
//
// (Its message also claimed to cover the dock, which it never did — the dock is
// useFromRack(rackSelection), with no bracket for that regex to match.)
test('the deliberate doors open the picker; the bulk dock alone still takes defaults', () => {
  const page = read('client/src/components/PlatesLifecycle.jsx');
  assert.equal((page.match(/const useFromRack = async/g) || []).length, 1);
  assert.equal((page.match(/const openPicker = async/g) || []).length, 1);
  // No single-PR door accepts a plate sight-unseen any more.
  assert.equal((page.match(/useFromRack\(\[/g) || []).length, 0,
    'the row, form header and form colour line must choose a plate, not accept one');
  // Row button, form header, form colour line — plus Change on a line that holds one.
  assert.ok((page.match(/onClick=\{\(\)\s*=>\s*openPicker\(/g) || []).length >= 3,
    'the row, form header and form colour line should all open the picker');
  // The one blind caller left is the dock, and it stays blind on purpose.
  assert.match(page, /useFromRack\(rackSelection\)/);
  // Offered before Approve on the row: approving is what puts a plate the plant
  // already owns onto a purchase order.
  const actions = page.slice(page.indexOf("{ key: 'actions', label: '', sortable: false"));
  assert.ok(actions.indexOf('from Rack') < actions.indexOf('canApproveRow(row)'),
    'Use from Rack must sit before Approve');
});

// ── The same artwork, spelled two ways ────────────────────────────────────
// Live plant data, 2026-08-12: of the ten open Plate PRs whose product HAS
// plates on the rack, eight read as having none — not because the artwork
// differs, but because the requirement carries the plant's short revision
// ("R1") while the plate was labelled with its full artwork code and revision
// ("PCS-W026/R1"), or because one side writes "PC402001" and the other
// "PC-402001". Compared character for character, the column would print 8 where
// the true figure is 41, and the plant would keep buying plates it owns.

test('punctuation and case are not an artwork difference', () => {
  assert.equal(plateArtworkKey('PC-402001'), plateArtworkKey('PC402001'));
  assert.equal(plateArtworkKey('pcs w026/r1'), plateArtworkKey('PCS-W026/R1'));
});

test('a bare revision may match the revision of a fuller label, and only that', () => {
  assert.ok(isBareArtworkRevision('R1'));
  assert.ok(isBareArtworkRevision('r0'));
  // The rack's trailing segment is what a bare revision is compared against.
  assert.equal(plateArtworkTrailingKey('PCS-W026/R1'), plateArtworkKey('R1'));
  assert.notEqual(plateArtworkTrailingKey('PCS-W026/R2'), plateArtworkKey('R1'),
    'R1 must never accept an R2 plate — that is a reprint of superseded artwork');
});

test('a code that is not a revision never matches a segment of another code', () => {
  // CI-TR-0095 asks for CI-MRG-0009 against a rack holding PCS-0253/R1. Those are
  // different artworks and must stay different however the strings are sliced.
  assert.equal(isBareArtworkRevision('CI-MRG-0009'), false);
  assert.equal(isBareArtworkRevision('PC402001'), false);
  assert.equal(isBareArtworkRevision('18721'), false);
  assert.notEqual(plateArtworkKey('CI-MRG-0009'), plateArtworkTrailingKey('PCS-0253/R1'));
});

test('an unversioned requirement claims nothing by accident', () => {
  // artworkVersionOf falls back to the string 'Unversioned'. It is not a revision
  // and must not spread across a product's whole rack.
  assert.equal(isBareArtworkRevision('Unversioned'), false);
  assert.equal(isBareArtworkRevision(''), false);
  assert.equal(isBareArtworkRevision(null), false);
});

test('the loosened comparison has exactly one spelling, used by both sides', () => {
  const plates = read('server/src/plates.js');
  const lifecycle = read('server/src/plate-lifecycle.js');
  const route = read('server/src/routes/plates.js');
  assert.match(plates, /export function plateArtworkMatchSql/);
  // The picker that hands out the plate and the count that promises it must ask
  // the same question, or the column offers what the button then refuses.
  assert.match(lifecycle, /plateArtworkMatchSql\(/);
  assert.match(route, /plateArtworkMatchSql\(/);
  assert.doesNotMatch(lifecycle, /lower\(pa\.artwork_version\)=lower\(\$/,
    'the raw string comparison must be gone, not merely joined by an OR elsewhere');
});

// The load-bearing law of this feature. The On Rack count, the picker's list and
// the plate the button actually takes must come from ONE query — otherwise the
// picker will one day offer a plate the button refuses. bestPlateCandidate is
// therefore not allowed to carry its own SQL; it is the head of plateCandidates.
test('bestPlateCandidate is the first row of plateCandidates, not a second query', () => {
  const lifecycle = read('server/src/plate-lifecycle.js');
  const best = lifecycle.slice(lifecycle.indexOf('export async function bestPlateCandidate'));
  const body = best.slice(0, best.indexOf('\n}'));
  assert.match(body, /plateCandidates\(/);
  assert.doesNotMatch(body, /SELECT pa\.\*/);
  assert.doesNotMatch(body, /ORDER BY/);
  // Exactly one place spells the candidate ordering.
  assert.equal(lifecycle.split('CASE pa.condition').length - 1, 1);
});

test('plateCandidates keeps the condition-then-wear ordering and the safety filters', () => {
  const lifecycle = read('server/src/plate-lifecycle.js');
  const fn = lifecycle.slice(lifecycle.indexOf('export async function plateCandidates'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.ok(body.length > 300, 'plateCandidates not found — the anchor moved');
  // The ordering itself is pinned on PLATE_CANDIDATE_ORDER_SQL (see the
  // least-worn test in plate-lifecycle-wiring); here it must be USED, unedited.
  assert.match(body, /ORDER BY \$\{PLATE_CANDIDATE_ORDER_SQL\}/);
  assert.match(body, /pa\.status='available' AND pa\.active=1/);
  assert.match(body, /pa\.condition IN \('Good','Fair'\)/);
  assert.match(body, /AND NOT \$\{PLATE_ALREADY_CLAIMED_SQL\}/);
});

// Production's pool is max: 1, so a module-level q() issued while a transaction
// holds the only client waits for itself for ever. Every candidate read inside a
// transaction has to use that transaction's own rows helper.
test('candidate reads inside a transaction use the transaction client', () => {
  const lifecycle = read('server/src/plate-lifecycle.js');
  const route = read('server/src/routes/plates.js');
  assert.doesNotMatch(lifecycle, /bestPlateCandidate\(oc,/);
  assert.doesNotMatch(route, /bestPlateCandidate\(oc,/);
});

const summaryOf = (ready, required) => ({ is_ready: ready === required && required > 0, ready, required });

test('a request holding a reserved rack plate reads rack_reserved', () => {
  const next = nextPlateRequestStatus({
    current: 'pending',
    rows: [{ status: 'verified_existing' }, { status: 'pr_required' }],
    summary: summaryOf(1, 2),
  });
  assert.equal(next, 'rack_reserved');
});

// The hole undo is the first caller to reach. Release the LAST verified_existing
// line and no branch used to fire — not ready, nothing in procurement, no
// verified_existing left, and the status is 'rack_reserved' rather than 'ready'.
// The PR then said "Rack reserved" while holding no plate at all.
test('releasing the last rack plate drops the request out of rack_reserved', () => {
  const next = nextPlateRequestStatus({
    current: 'rack_reserved',
    rows: [{ status: 'pr_required' }, { status: 'pr_required' }],
    summary: summaryOf(0, 2),
  });
  assert.equal(next, 'pending');
});

test('procurement outranks a rack reservation, and readiness outranks both', () => {
  assert.equal(nextPlateRequestStatus({
    current: 'rack_reserved',
    rows: [{ status: 'verified_existing' }, { status: 'po_created' }],
    summary: summaryOf(1, 2),
  }), 'procurement');
  assert.equal(nextPlateRequestStatus({
    current: 'rack_reserved',
    rows: [{ status: 'verified_existing' }, { status: 'verified_existing' }],
    summary: summaryOf(2, 2),
  }), 'ready');
});

test('a status with nothing to say about it is left alone', () => {
  assert.equal(nextPlateRequestStatus({
    current: 'procurement',
    rows: [{ status: 'pr_required' }],
    summary: summaryOf(0, 1),
  }), 'procurement');
});

// ── The planner picks WHICH plate fills each colour ────────────────────────

const pickComponent = (id, label, extra = {}) => ({
  id, component_label: label, status: extra.status || 'pr_required',
  matched_asset_id: extra.matched_asset_id || null,
});

test('an explicit pick assigns the plate the planner named', () => {
  const out = resolveRackPicks({
    components: [pickComponent(1, 'Cyan')],
    picks: [{ component_id: 1, asset_id: 903 }],
    candidates: { 1: [{ id: 901 }, { id: 903 }] },
  });
  assert.deepEqual(out.assignments, [
    { component_id: 1, asset_id: 903, swap: false, previous_asset_id: null },
  ]);
  assert.deepEqual(out.skipped, []);
  assert.deepEqual(out.consumed, [903]);
});

// A pick is a choice among what is offered. A plate id that never appeared in
// the candidate list is not a preference, it is a plate from another job.
test('a pick outside the candidate set is refused and nothing is assigned', () => {
  assert.throws(() => resolveRackPicks({
    components: [pickComponent(1, 'Cyan')],
    picks: [{ component_id: 1, asset_id: 555 }],
    candidates: { 1: [{ id: 901 }, { id: 903 }] },
  }), error => error.status === 409 && /not on offer for Cyan/.test(error.message));
});

// Two Cyan lines list the same plates on purpose — the planner may want plate X
// on the second line. One physical plate still cannot fill both.
test('the same plate picked for two lines is taken once and the second is named', () => {
  const out = resolveRackPicks({
    components: [pickComponent(1, 'Cyan'), pickComponent(2, 'Cyan')],
    picks: [{ component_id: 1, asset_id: 903 }, { component_id: 2, asset_id: 903 }],
    candidates: { 1: [{ id: 903 }], 2: [{ id: 903 }] },
  });
  assert.equal(out.assignments.length, 1);
  assert.equal(out.assignments[0].component_id, 1);
  assert.deepEqual(out.skipped, [
    { component_id: 2, component_label: 'Cyan', asset_id: 903, reason: 'duplicate' },
  ]);
});

test('picking a different plate for a line that already holds one is a swap', () => {
  const out = resolveRackPicks({
    components: [pickComponent(1, 'Cyan', { status: 'verified_existing', matched_asset_id: 901 })],
    picks: [{ component_id: 1, asset_id: 903 }],
    candidates: { 1: [{ id: 901 }, { id: 903 }] },
  });
  assert.deepEqual(out.assignments, [
    { component_id: 1, asset_id: 903, swap: true, previous_asset_id: 901 },
  ]);
});

// Pressing Confirm without touching a line must be free. The candidate list is
// EMPTY here on purpose: plateCandidates excludes a held plate from every list —
// including its own line's, via PLATE_ALREADY_CLAIMED_SQL — so this is the state
// the confirm path actually sees. Asserting it with the plate present would pass
// while describing a situation the system cannot produce.
test('re-picking the plate a line already holds does nothing, even when it is not on offer', () => {
  const out = resolveRackPicks({
    components: [pickComponent(1, 'Cyan', { status: 'verified_existing', matched_asset_id: 901 })],
    picks: [{ component_id: 1, asset_id: 901 }],
    candidates: { 1: [] },
  });
  assert.deepEqual(out.assignments, []);
  assert.deepEqual(out.skipped, []);
});

// The component axis. `consumed` stops one plate filling two lines; without a
// second guard nothing stopped two picks filling one line — reserving two plates
// and writing matched_asset_id twice, leaving a plate reserved with no component
// pointing at it.
test('two picks for the same line take the first and name the second', () => {
  const out = resolveRackPicks({
    components: [pickComponent(1, 'Cyan')],
    picks: [{ component_id: 1, asset_id: 903 }, { component_id: 1, asset_id: 905 }],
    candidates: { 1: [{ id: 903 }, { id: 905 }] },
  });
  assert.deepEqual(out.assignments, [
    { component_id: 1, asset_id: 903, swap: false, previous_asset_id: null },
  ]);
  assert.deepEqual(out.skipped, [
    { component_id: 1, component_label: 'Cyan', asset_id: 905, reason: 'line_already_picked' },
  ]);
  assert.deepEqual(out.consumed, [903], 'the rejected plate must stay free for another line');
});

test('a malformed candidate list is refused, never trusted as an empty offer', () => {
  // candidates arrives from the caller, not the browser — but a shape error here
  // must surface as a refusal, not a TypeError 500 halfway through a transaction.
  assert.throws(() => resolveRackPicks({
    components: [pickComponent(1, 'Cyan')],
    picks: [{ component_id: 1, asset_id: 903 }],
    candidates: { 1: 'not a list' },
  }), error => error.status === 409);
  assert.throws(() => resolveRackPicks({
    components: [pickComponent(1, 'Cyan')],
    picks: [{ component_id: 1, asset_id: 903 }],
    candidates: null,
  }), error => error.status === 409);
});

// One spelling. This file already exports PLATE_HELD_COMPONENT_STATUSES so the
// "is that plate spoken for?" question cannot drift from the "is this line
// ready?" one; the on-order list needs the same treatment for the same reason.
test('the on-order statuses are named once, not copied into the status machine', () => {
  const plates = read('server/src/plates.js');
  assert.match(plates, /export const PLATE_ON_ORDER_COMPONENT_STATUSES/);
  const fn = plates.slice(plates.indexOf('export function nextPlateRequestStatus'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.ok(body.length > 100, 'nextPlateRequestStatus not found — the anchor moved');
  assert.match(body, /PLATE_ON_ORDER_COMPONENT_STATUSES/);
  assert.doesNotMatch(body, /'po_created'/);
});

test('a pick naming a component that is not on this requirement is ignored', () => {
  const out = resolveRackPicks({
    components: [pickComponent(1, 'Cyan')],
    picks: [{ component_id: 99, asset_id: 903 }],
    candidates: { 1: [{ id: 903 }] },
  });
  assert.deepEqual(out.assignments, []);
});

// ── Undo reaches exactly as far as the rack ────────────────────────────────

const held = (id, label, assetId) => ({
  id, component_label: label, status: 'verified_existing', matched_asset_id: assetId,
});

test('undo releases every line holding a rack plate when no line is named', () => {
  const out = releasableRackComponents({
    components: [held(1, 'Cyan', 901), held(2, 'Magenta', 902), pickComponent(3, 'Yellow')],
  });
  assert.deepEqual(out.releasable.map(row => row.id), [1, 2]);
  assert.deepEqual(out.refused, [
    { component_id: 3, component_label: 'Yellow', reason: 'no_plate' },
  ]);
});

test('undo can be scoped to one line', () => {
  const out = releasableRackComponents({
    components: [held(1, 'Cyan', 901), held(2, 'Magenta', 902)],
    componentIds: [2],
  });
  assert.deepEqual(out.releasable.map(row => row.id), [2]);
  assert.deepEqual(out.refused, []);
});

// Undo reaches exactly as far as the rack. A plate on the press has physically
// gone; bringing it back is a return, and the return flow owns that.
test('a plate already issued to printing is refused BY NAME, not skipped in silence', () => {
  assert.throws(() => releasableRackComponents({
    components: [{ id: 1, component_label: 'Cyan', status: 'issued', matched_asset_id: 901 }],
  }), error => error.status === 409
    && error.body.code === 'NO_RACK_PLATE_HELD'
    && error.refused[0].component_label === 'Cyan'
    && error.refused[0].reason === 'issued');
});

test('undo on a requirement holding nothing refuses rather than reporting success', () => {
  assert.throws(() => releasableRackComponents({
    components: [pickComponent(1, 'Cyan')],
  }), error => error.status === 409 && error.body.code === 'NO_RACK_PLATE_HELD');
});

test('the candidates endpoint offers claimable lines and lines already holding a plate', () => {
  const route = read('server/src/routes/plates.js');
  const fn = route.slice(route.indexOf("r.get('/plates/requirements/:id/rack-candidates'"));
  const body = fn.slice(0, fn.indexOf("\nr.post('"));
  // Non-vacuous: a slice anchored on a name silently passes against the wrong
  // function if the anchor moves, so prove we sliced something real first.
  assert.ok(body.length > 400, 'rack-candidates route body not found — the anchor moved');
  // Same gate as spending a plate.
  assert.match(fn.slice(0, 120), /rack-candidates', canVerify/);
  // Claimable lines, PLUS verified_existing so the form can offer Change.
  assert.match(body, /RACK_CLAIMABLE_COMPONENT_STATUSES/);
  assert.match(body, /verified_existing/);
  // One spelling of the candidate set — never a hand-rolled second query.
  assert.match(body, /plateCandidates\(/);
  assert.doesNotMatch(body, /SELECT pa\.\* FROM plate_assets/);
  // The plate a line already holds is listed first and flagged.
  assert.match(body, /current: /);
});

// PARITY, the law this whole feature rests on: the picker must list exactly what
// the button would take. Both sides therefore filter by the COMPONENT's own
// plate_master_id. Approve stamps plate_master_id only on the components it
// approved (routes/plates.js, `WHERE id=ANY($3::int[])`), so a partly-approved PR
// holds approved lines with a size and claimable lines with NULL — and the
// request-level master would filter the picker to a size the button ignores,
// showing fewer plates than the click would spend.
test('the picker and the button filter candidates by the same plate master', () => {
  const route = read('server/src/routes/plates.js');
  const picker = route.slice(route.indexOf("r.get('/plates/requirements/:id/rack-candidates'"));
  const pickerBody = picker.slice(0, picker.indexOf("\nr.post('"));
  assert.ok(pickerBody.length > 400, 'rack-candidates route body not found — the anchor moved');
  assert.match(pickerBody, /plateCandidates\(q, request, component, component\.plate_master_id\)/);
  assert.doesNotMatch(pickerBody, /requestPlateMasterId/);

  const button = route.slice(route.indexOf("r.post('/plates/requirements/:id/use-from-rack'"));
  const buttonBody = button.slice(0, button.indexOf("\nr.post('/plates/requirements/:id/approve'"));
  assert.ok(buttonBody.length > 500, 'use-from-rack route body not found — the anchor moved');
  assert.match(buttonBody, /component\.plate_master_id/);
});

// One plate may not read a day older in the picker than on the warehouse page.
// Age comes from SQL everywhere in this file; the Node clock rounds at midday
// while date subtraction is whole days.
test('plate age is read from the database, never from the Node clock', () => {
  const route = read('server/src/routes/plates.js');
  const lifecycle = read('server/src/plate-lifecycle.js');
  const shape = route.slice(route.indexOf('const shapeCandidate'));
  const body = shape.slice(0, shape.indexOf('});'));
  assert.ok(body.length > 200, 'shapeCandidate not found — the anchor moved');
  assert.doesNotMatch(body, /Date\.now\(\)/);
  assert.match(body, /row\.age_days/);
  assert.match(lifecycle, /\(CURRENT_DATE-pa\.plate_created_on\)::int AS age_days/);
});

test('use-from-rack takes explicit picks but still works blind', () => {
  const route = read('server/src/routes/plates.js');
  const fn = route.slice(route.indexOf("r.post('/plates/requirements/:id/use-from-rack'"));
  const body = fn.slice(0, fn.indexOf("\nr.post('/plates/requirements/:id/approve'"));
  assert.ok(body.length > 500, 'use-from-rack route body not found — the anchor moved');
  // Picks are resolved by the pure validator, never trusted raw.
  assert.match(body, /resolveRackPicks\(/);
  assert.match(body, /req\.body\.picks/);
  // A line with no pick still falls back to the default — this is what keeps the
  // bulk dock and every existing caller working unchanged.
  assert.match(body, /bestPlateCandidate\(/);
  // A swap releases the old plate before reserving the new one, in this same tx.
  assert.match(body, /previous_asset_id|assigned\?\.swap/);
  assert.match(body, /swapped/);
  // The response names what it could not take.
  assert.match(body, /skipped/);
});

test('a line already satisfied is only reopened by a pick naming a different plate', () => {
  const route = read('server/src/routes/plates.js');
  const fn = route.slice(route.indexOf("r.post('/plates/requirements/:id/use-from-rack'"));
  const body = fn.slice(0, fn.indexOf("\nr.post('/plates/requirements/:id/approve'"));
  assert.ok(body.length > 500, 'use-from-rack route body not found — the anchor moved');
  // Blind callers must never re-pick a line that already holds a plate.
  assert.match(body, /RACK_CLAIMABLE_COMPONENT_STATUSES/);
  assert.match(body, /pickedComponentIds/);
});

// Production's pool is max: 1, so a module-level q() issued while a transaction
// holds the only client waits for itself for ever. This cannot be a file-level
// rule: GET /rack-candidates is outside any transaction and calls
// plateCandidates(q, ...) correctly, in this same file.
test('use-from-rack reads candidates on the transaction client, never the pool', () => {
  const route = read('server/src/routes/plates.js');
  const fn = route.slice(route.indexOf("r.post('/plates/requirements/:id/use-from-rack'"));
  const body = fn.slice(0, fn.indexOf("\nr.post('/plates/requirements/:id/approve'"));
  assert.ok(body.length > 500, 'use-from-rack route body not found — the anchor moved');
  assert.match(body, /plateCandidates\(qc,/);
  assert.doesNotMatch(body, /plateCandidates\(q,/);
});

test('releaseDraftPlateAssets reports what it could not release', () => {
  const route = read('server/src/routes/plates.js');
  const fn = route.slice(route.indexOf('async function releaseDraftPlateAssets'));
  const body = fn.slice(0, fn.indexOf('\nasync function deletePlateRequirements'));
  assert.ok(body.length > 300, 'releaseDraftPlateAssets not found — the anchor moved');
  // Delete may ignore a plate that moved on; an explicit undo may not.
  assert.match(body, /released/);
  assert.match(body, /skipped/);
  assert.match(body, /return \{ released, skipped \}/);
});

test('undo returns the plate, resets the line, and refuses by name', () => {
  const route = read('server/src/routes/plates.js');
  const fn = route.slice(route.indexOf("r.post('/plates/requirements/:id/release-rack'"));
  const body = fn.slice(0, fn.indexOf('\nr.post(', 10));
  assert.ok(body.length > 500, 'release-rack route body not found — the anchor moved');
  assert.match(fn.slice(0, 120), /release-rack', canVerify/);
  assert.match(body, /releasableRackComponents\(/);
  assert.match(body, /releaseDraftPlateAssets\(/);
  // The line goes back to needing a plate — and to being approvable onto a PO.
  assert.match(body, /status='pr_required'/);
  assert.match(body, /matched_asset_id=NULL/);
  assert.match(body, /proposed_asset_id=NULL/);
  assert.match(body, /verified_found=NULL/);
  // A structured code no page handles is a dead button; this one must be sent,
  // and under `body` or app.js drops it.
  assert.match(body, /RACK_PLATE_GONE/);
  assert.match(body, /body: \{ code: 'RACK_PLATE_GONE' \}/);
  assert.match(body, /syncPlateRequest\(/);
});

test('the picker opens on the plate the line already holds, else the best candidate', () => {
  const selection = defaultPickSelection([
    { component_id: 1, candidates: [{ id: 901 }, { id: 903 }] },
    { component_id: 2, candidates: [{ id: 905 }, { id: 907, current: true }] },
    { component_id: 3, candidates: [] },
  ]);
  assert.deepEqual(selection, { 1: 901, 2: 907, 3: null });
});

test('picking one plate for two lines is caught before the request is sent', () => {
  assert.deepEqual(duplicatePickAssets({ 1: 903, 2: 903, 3: 905 }), [903]);
  assert.deepEqual(duplicatePickAssets({ 1: 903, 2: 905 }), []);
  // An unticked line is not a duplicate, however many there are.
  assert.deepEqual(duplicatePickAssets({ 1: null, 2: null }), []);
});

test('unticked lines are left out of the payload entirely', () => {
  assert.deepEqual(pickPayload({ 1: 903, 2: null, 3: 905 }), [
    { component_id: 1, asset_id: 903 },
    { component_id: 3, asset_id: 905 },
  ]);
});

test('the picker shows what distinguishes two identical-looking plates', () => {
  const modal = read('client/src/components/RackPickerModal.jsx');
  // Condition, wear and idle time are the whole reason to choose one over another.
  for (const field of ['asset_number', 'rack_location', 'condition', 'use_count', 'age_days']) {
    assert.match(modal, new RegExp(field));
  }
  // No arithmetic in the modal — selection logic lives in the tested lib.
  assert.match(modal, /from '\.\.\/lib\/plateRack\.js'/);
  assert.match(modal, /defaultPickSelection/);
  assert.match(modal, /duplicatePickAssets/);
  assert.match(modal, /pickPayload/);
  // A line may be left for the PO.
  assert.match(modal, /Buy this one/);
});

test('three of the four rack doors open the picker, and the bulk dock stays blind', () => {
  const page = read('client/src/components/PlatesLifecycle.jsx');
  assert.match(page, /RackPickerModal/);
  assert.match(page, /rack-candidates/);
  assert.match(page, /release-rack/);
  // Bulk across many PRs keeps taking defaults on purpose: picking plates for
  // twelve selected PRs is a lot of clicking for the case where the default is
  // right. It is the "I trust the ordering" door.
  //
  // Anchored on <SelectionDock, not on `const rackSelection`. The two sit 34,000
  // characters apart — the filter is computed with the other memos near the top
  // of the component and spent in the JSX far below — so a window tight enough to
  // mean anything cannot span them. <SelectionDock appears exactly once and IS
  // the dock, which is the thing this test is about.
  assert.match(page, /const rackSelection/);
  const dock = page.slice(page.indexOf('<SelectionDock'));
  assert.ok(dock.length > 500, 'SelectionDock not found — the anchor moved');
  assert.match(dock.slice(0, 4000), /useFromRack\(rackSelection\)/);
});

test('a structured refusal from undo is rendered, not swallowed', () => {
  const page = read('client/src/components/PlatesLifecycle.jsx');
  assert.match(page, /releaseRack/);
  // Every refusal the server names must reach a toast — a structured code no
  // page handles is a dead button.
  assert.match(page, /skipped/);
});

// The modal re-seeds its selection whenever `lines` changes identity. Rebuilt
// inline, that discards the planner's picks on every render.
test('the picker is fed lines from state, never an array rebuilt each render', () => {
  const page = read('client/src/components/PlatesLifecycle.jsx');
  assert.match(page, /<RackPickerModal[\s\S]{0,400}lines=\{picker\?\.lines \|\| \[\]\}/);
});

// "Buy this one" is a decision, not an omission. The picker sends picks only for
// the lines the planner ticked; an unticked line means that colour goes on the
// purchase order. Falling through to bestPlateCandidate reserved a plate they
// had just refused — caught only by driving the real modal, because the pure
// validator is correct and it is the route's eligibility rule that was wrong.
// The bulk dock sends no picks at all and must keep its blind fallback.
test('a line left unpicked is left for the purchase order, not filled blind', () => {
  const route = read('server/src/routes/plates.js');
  const fn = route.slice(route.indexOf("r.post('/plates/requirements/:id/use-from-rack'"));
  const body = fn.slice(0, fn.indexOf("\nr.post('/plates/requirements/:id/release-rack'"));
  assert.ok(body.length > 500, 'use-from-rack route body not found — the anchor moved');
  assert.match(body, /if \(picks\.length && !pickedComponentIds\.has\(row\.id\)\) return false;/);
  // and the blind path survives: no picks, no restriction
  assert.match(body, /picks\.length &&/);
});
