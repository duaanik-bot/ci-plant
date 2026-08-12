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
} from './plates.js';

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
  assert.match(route, /rack_reuse: rackReusePlan\(\{/);
});

test('the row, the form and the dock all reuse through one function', () => {
  const page = read('client/src/components/PlatesLifecycle.jsx');
  assert.equal((page.match(/const useFromRack = async/g) || []).length, 1);
  assert.ok((page.match(/useFromRack\(\[/g) || []).length >= 3,
    'row, form colour line and bulk dock should all route through useFromRack');
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
