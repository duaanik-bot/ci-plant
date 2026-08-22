// The wear a Requirement row reports must include the plates the Use-from-Rack
// click would actually take — not only the plates already attached to it.
//
// Two rows telling the same operational story looked different: a PR whose set
// was PROPOSED at creation carried "Used ×1" and the red tint, while a PR whose
// colours went pr_required and whose plates only came back to the shelf LATER
// showed a live "5 of 5 on rack" offer beside an empty Quality cell and no
// tint. Both jobs will print off the same used aluminium; only one warned.
//
// The law extends PARITY one step: the wear the row prints is the wear of the
// plates the button would take — the plan's own `taking`, never a second
// reading of the shelf.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rackReusePlan, plateWearSummary, plateWearRemark } from './plates.js';

const root = new URL('../../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');

let nextId = 1;
const component = (component_type, status, extra = {}) => ({
  id: extra.id ?? nextId++,
  component_type,
  component_label: extra.component_label
    || (component_type === 'pantone' ? `Pantone - ${extra.pantone_code}` : component_type),
  pantone_code: extra.pantone_code || null,
  status,
  ...extra,
});
const candidate = (asset_number, use_count, extra = {}) => ({
  id: extra.id ?? nextId++,
  asset_number,
  use_count,
  condition: extra.condition || 'Good',
  last_used_at: extra.last_used_at || null,
  plate_created_on: extra.plate_created_on || null,
});
const rackWith = (component_type, candidates, pantone_code = null) => ({
  component_type, pantone_code, available: candidates.length, candidates,
});

// ── rackReusePlan carries WHICH plates the click takes ──────────────────────

test('a plan line takes the first `usable` candidates, in candidate order', () => {
  const plan = rackReusePlan({
    components: [component('cyan', 'pr_required')],
    available: [rackWith('cyan', [candidate('A-1', 1), candidate('A-2', 3)])],
  });
  const [line] = plan.lines;
  assert.equal(line.usable, 1);
  assert.deepEqual(line.taking.map(row => row.asset_number), ['A-1']);
});

test('a line with no candidate detail still answers, taking nothing', () => {
  const plan = rackReusePlan({
    components: [component('cyan', 'pr_required')],
    available: [{ component_type: 'cyan', pantone_code: null, available: 2 }],
  });
  assert.equal(plan.total, 1);
  assert.deepEqual(plan.lines[0].taking, []);
});

// ── plateWearSummary reads the plan's taking for plateless colours ──────────

const fourToBuy = () => [
  component('cyan', 'pr_required'), component('magenta', 'pr_required'),
  component('yellow', 'pr_required'), component('black', 'pr_required'),
];
const fullOffer = (runs = 1) => rackReusePlan({
  components: fourToBuy(),
  available: [
    rackWith('cyan', [candidate('C-1', runs)]), rackWith('magenta', [candidate('M-1', runs)]),
    rackWith('yellow', [candidate('Y-1', runs)]), rackWith('black', [candidate('K-1', runs)]),
  ],
});

test('a fully offered set of used plates reports Used, and says it is an offer', () => {
  const summary = plateWearSummary(fourToBuy(), fullOffer(1));
  assert.ok(summary, 'an offer-covered requirement must have wear to report');
  assert.equal(summary.wear, 'used');
  assert.equal(summary.plates, 4);
  assert.equal(summary.offered, 4);
  assert.ok(summary.components.every(row => row.source === 'offer'));
  assert.deepEqual(summary.replace, []);
  assert.equal(plateWearRemark(summary), 'Condition Good — none due');
});

test('a fully offered set of fresh plates stays Fresh', () => {
  const summary = plateWearSummary(fourToBuy(), fullOffer(0));
  assert.equal(summary.wear, 'fresh');
  assert.equal(summary.offered, 4);
});

test('held and offered plates fold into one verdict', () => {
  const components = [
    component('cyan', 'verification_required', {
      proposed_asset_id: 900, proposed_asset_number: 'H-1', proposed_use_count: 0,
      proposed_condition: 'Good',
    }),
    component('magenta', 'pr_required'),
  ];
  const plan = rackReusePlan({
    components, available: [rackWith('magenta', [candidate('M-1', 2)])],
  });
  const summary = plateWearSummary(components, plan);
  assert.equal(summary.plates, 2);
  assert.equal(summary.offered, 1);
  assert.equal(summary.wear, 'used');
});

test('a colour that already holds a plate never consumes the offer too', () => {
  const components = [component('cyan', 'verification_required', {
    proposed_asset_id: 901, proposed_asset_number: 'H-2', proposed_use_count: 1,
    proposed_condition: 'Good',
  })];
  // verification_required is claimable, so the plan offers this colour — but the
  // component already holds its plate; counting the offer as well would report
  // five plates on a four-colour job.
  const plan = rackReusePlan({
    components, available: [rackWith('cyan', [candidate('C-9', 4)])],
  });
  const summary = plateWearSummary(components, plan);
  assert.equal(summary.plates, 1);
  assert.equal(summary.offered, 0);
  assert.equal(summary.components[0].asset_number, 'H-2');
});

test('the plate a sibling colour holds is not re-offered to a plateless one', () => {
  const held = component('cyan', 'verification_required', {
    proposed_asset_id: 77, proposed_asset_number: 'C-77', proposed_use_count: 1,
    proposed_condition: 'Good',
  });
  const bare = component('cyan', 'pr_required');
  const plan = rackReusePlan({
    components: [held, bare],
    available: [rackWith('cyan', [{ ...candidate('C-77', 1), id: 77 }, candidate('C-78', 2)])],
  });
  const summary = plateWearSummary([held, bare], plan);
  const numbers = summary.components.map(row => row.asset_number).sort();
  assert.deepEqual(numbers, ['C-77', 'C-78']);
  assert.equal(summary.offered, 1);
});

test('a Fair plate in the offer is named for replacement, same rule as a held one', () => {
  const summary = plateWearSummary(
    [component('cyan', 'pr_required')],
    rackReusePlan({
      components: [component('cyan', 'pr_required')],
      available: [rackWith('cyan', [candidate('C-F', 3, { condition: 'Fair' })])],
    }));
  assert.equal(summary.replace.length, 1);
  assert.match(plateWearRemark(summary), /^Replace /);
});

test('no plates held and nothing offered is still null — nothing to report', () => {
  assert.equal(plateWearSummary(fourToBuy(), rackReusePlan({
    components: fourToBuy(), available: [],
  })), null);
  assert.equal(plateWearSummary(fourToBuy()), null);
});

test('a cancelled colour consumes nothing from the offer', () => {
  const components = [component('cyan', 'cancelled')];
  const plan = rackReusePlan({
    components: [component('cyan', 'pr_required')],
    available: [rackWith('cyan', [candidate('C-1', 1)])],
  });
  assert.equal(plateWearSummary(components, plan), null);
});

// ── the register wires the plan into the wear, and there is ONE candidate order ─

test('requirementRows computes wear FROM the reuse plan, not beside it', () => {
  const route = read('server/src/routes/plates.js');
  assert.ok(route.length > 10000, 'routes/plates.js read failed — anchor moved');
  assert.match(route, /plateWearSummary\(requestComponents,\s*\w*[Rr]euse/,
    'the register must hand the rack offer to plateWearSummary');
});

test('the candidate order is spelled ONCE and shared by picker and register', () => {
  const lifecycle = read('server/src/plate-lifecycle.js');
  const route = read('server/src/routes/plates.js');
  assert.ok(lifecycle.length > 10000 && route.length > 10000, 'source read failed');
  assert.match(lifecycle, /export const PLATE_CANDIDATE_ORDER_SQL/);
  const spellings = (lifecycle + route).match(/WHEN 'Good' THEN 0/g) || [];
  assert.equal(spellings.length, 1,
    'the condition-first ordering must exist only inside PLATE_CANDIDATE_ORDER_SQL');
  assert.match(route, /PLATE_CANDIDATE_ORDER_SQL/,
    'rackAvailabilityByRequest must rank candidates by the shared order');
});

test('the availability query carries the wear of each candidate plate', () => {
  const route = read('server/src/routes/plates.js');
  const fn = route.slice(route.indexOf('async function rackAvailabilityByRequest'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.ok(body.length > 300, 'rackAvailabilityByRequest not found — anchor moved');
  for (const field of ['use_count', 'condition', 'asset_number', 'last_used_at']) {
    assert.ok(body.includes(field), `candidates must carry ${field}`);
  }
});
