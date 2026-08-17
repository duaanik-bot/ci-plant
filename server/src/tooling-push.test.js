import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pushTargets } from './tooling-gate.js';

// The live case this was written from — Artwork Queue, MAYORANDIL 5 TABLET
// INNER (product 860, order line 201). One active plate row, PLT-0004, sitting
// in `incoming` since the earlier push. Nothing is on the rack.
//
// What the plant saw: "Already in hub: Plate Set", and the push refused. Two
// separate wrongs in one toast — it called a row in Incoming a plate that
// exists, and then used that to block the send.
const mkTool = (over = {}) => ({
  id: 752, family: 'plate', code: 'PLT-0004', product_id: 860,
  zone: 'incoming', condition: 'Good', active: 1, ...over,
});

// ── A row in the pipeline is not a tool the plant holds ─────────────────────

test('a plate still in incoming is PENDING, never present', () => {
  const [plate] = pushTargets(['plate'], [mkTool()]);
  assert.deepEqual(plate.present, [], 'PLT-0004 is in Incoming — nothing is on the rack');
  assert.deepEqual(plate.pending.map(t => t.code), ['PLT-0004']);
});

test('a plate at the maker is PENDING too — making is not the rack', () => {
  const [plate] = pushTargets(['plate'], [mkTool({ zone: 'making' })]);
  assert.deepEqual(plate.present, []);
  assert.deepEqual(plate.pending.map(t => t.code), ['PLT-0004']);
});

test('only the rack and the floor count as present', () => {
  for (const zone of ['in_rack', 'on_floor']) {
    const [plate] = pushTargets(['plate'], [mkTool({ zone })]);
    assert.deepEqual(plate.present.map(t => t.code), ['PLT-0004'], zone);
    assert.deepEqual(plate.pending, [], zone);
  }
});

test('a scrapped plate on the rack is not present either', () => {
  // toolReady()'s own rule, borrowed rather than restated — a second spelling is
  // how the push starts disagreeing with the gate.
  const [plate] = pushTargets(['plate'], [mkTool({ zone: 'in_rack', condition: 'Scrapped' })]);
  assert.deepEqual(plate.present, []);
  assert.deepEqual(plate.pending.map(t => t.code), ['PLT-0004']);
});

test('a soft-deleted row is neither present nor pending — it is gone', () => {
  const [plate] = pushTargets(['plate'], [mkTool({ active: 0 })]);
  assert.deepEqual(plate.present, []);
  assert.deepEqual(plate.pending, []);
});

// ── Every requested family is a target. The send is never refused ───────────

test('a family with a pending row is still a target — the send goes again', () => {
  // The blocker. `have.has(family) -> skip` refused the second push outright.
  const targets = pushTargets(['plate'], [mkTool()]);
  assert.equal(targets.length, 1, 'plate must still be sent, pending row or not');
  assert.equal(targets[0].family, 'plate');
});

test('a family already on the rack is still a target', () => {
  // Anik: remove the blocker. A present plate is reported, not enforced — the
  // modal shows it before the button is pressed, which is where the judgement
  // belongs.
  const targets = pushTargets(['plate'], [mkTool({ zone: 'in_rack' })]);
  assert.equal(targets.length, 1);
  assert.deepEqual(targets[0].present.map(t => t.code), ['PLT-0004']);
});

test('every requested family comes back, in the order asked', () => {
  assert.deepEqual(pushTargets(['plate', 'die', 'block'], []).map(t => t.family),
    ['plate', 'die', 'block']);
});

test('families are de-duplicated and unknown ones dropped', () => {
  assert.deepEqual(pushTargets(['plate', 'plate', 'shade_card', 'nonsense'], []).map(t => t.family),
    ['plate']);
  assert.deepEqual(pushTargets([], []), []);
  assert.deepEqual(pushTargets(undefined, undefined), []);
});

test('each target carries the label the plant reads', () => {
  assert.deepEqual(pushTargets(['plate', 'die'], []).map(t => t.label), ['Plate Set', 'Die']);
});

test('another family’s rows are not this family’s business', () => {
  const [plate] = pushTargets(['plate'], [mkTool({ id: 9, family: 'die', code: 'DIE-0001', zone: 'in_rack' })]);
  assert.deepEqual(plate.present, []);
  assert.deepEqual(plate.pending, []);
});

test('present and pending are both reported when the product has each', () => {
  const [plate] = pushTargets(['plate'], [
    mkTool({ id: 1, code: 'PLT-0004', zone: 'incoming' }),
    mkTool({ id: 2, code: 'PLT-0009', zone: 'in_rack' }),
  ]);
  assert.deepEqual(plate.present.map(t => t.code), ['PLT-0009']);
  assert.deepEqual(plate.pending.map(t => t.code), ['PLT-0004']);
});

// ── The route: one new row per send, never folded into the old one ──────────

test('the route inserts unconditionally — no skip, no reuse', () => {
  // Structural, because the failure mode is silent: reinstating the skip breaks
  // no test that calls a function, it just quietly refuses the plant again.
  const route = readFileSync(new URL('./routes/tooling.js', import.meta.url), 'utf8');
  const door = route.slice(route.indexOf("r.post('/tools/push'"));
  const body = door.slice(0, door.indexOf("r.put('/tools/:id'"));

  assert.ok(body.includes('pushTargets('),
    'the push must read its targets through pushTargets() so the route and the '
    + 'gate cannot disagree about what "already there" means');
  assert.ok(!/\bskipped\b/.test(body),
    'the push is reporting a `skipped` family again — a send is never refused. '
    + 'Report what is present; do not withhold the send.');
  assert.ok(!/\bcontinue\b/.test(body),
    'the push loop skips a family again. Every requested family gets its own row.');
  assert.ok(/INSERT INTO tools/.test(body), 'the push still has to create the row');
  assert.ok(!/UPDATE tools/.test(body),
    'the push is updating an existing tools row — a re-send must be its own '
    + 'separate line beside the old one, never folded into it');
});

test('the modal never calls a pending tool "In hub"', () => {
  // The client half of the same lie. `d.status !== 'missing'` painted a plate in
  // Incoming with the same green pill as one on the rack.
  const page = readFileSync(new URL('../../client/src/pages/Artwork.jsx', import.meta.url), 'utf8');
  assert.ok(!/status\s*!==\s*'missing'/.test(page),
    'PushToToolingModal is back to treating any non-missing tool as in hub — a '
    + "plate in Incoming is pending, and must not read as one the plant holds.");
  assert.ok(!/Already in hub/.test(page),
    '"Already in hub" is back. It was the false claim: the row was in Incoming.');
});
