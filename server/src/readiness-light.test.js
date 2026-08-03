import test from 'node:test';
import assert from 'node:assert/strict';
import { readinessLight, lightForJobCards, LIGHT_LABEL } from './readiness-light.js';

// A job whose every gate is satisfied — each test spoils exactly one fact, so
// what it asserts is what it changed.
const mkGates = (over = {}) => ({
  artwork: true,
  tooling: true,
  tooling_detail: [
    { family: 'die',   label: 'Die',       hard: true,  status: 'ready', code: 'DIE-0001', zone: 'in_rack', condition: 'Good' },
    { family: 'plate', label: 'Plate Set', hard: false, status: 'ready', code: 'PLT-0001', zone: 'in_rack', condition: 'Good' },
    { family: 'shade_card', label: 'Shade Card', hard: false, status: 'ready', code: 'SC-0001' },
  ],
  material: true,
  material_pending: false,
  parent_needed: 100,
  available_sheets: 400,
  ...over,
});

const light = ({ gates = {}, ...rest } = {}) => readinessLight({
  gates: mkGates(gates),
  cuttingStatus: 'completed',
  machineId: 3,
  finalisedAt: '2026-07-30T04:00:00Z',
  shade: { eligible: true, reason: null },
  ...rest,
});

const byKey = l => Object.fromEntries(l.items.map(i => [i.key, i]));

// ── Shape ─────────────────────────────────────────────────────────────
test('labels: the three words the operator reads', () => {
  assert.deepEqual(LIGHT_LABEL, { red: 'Blocked', amber: 'Partly ready', green: 'Ready to run' });
});

test('shape: nine items, in the contract order', () => {
  assert.deepEqual(light().items.map(i => i.key), [
    'artwork', 'board_available', 'board_cut', 'plate', 'die', 'shade', 'ink', 'machine', 'released',
  ]);
});

test('shape: every item carries the full contract row', () => {
  for (const it of light().items) {
    assert.deepEqual(Object.keys(it), ['key', 'label', 'state', 'note', 'hard', 'tracked'], it.key);
    assert.ok(['ok', 'pending', 'blocked', 'na'].includes(it.state), `${it.key}=${it.state}`);
  }
});

test('shape: only artwork and board are hard — the two the ERP still refuses on', () => {
  // Shade left this list when printing start became an acknowledge-and-run
  // alarm. Hard means "the ERP will turn you away"; a warning the supervisor
  // can accept is not that, and a red dot in front of a press that will
  // actually start is the dot lying.
  assert.deepEqual(light().items.filter(i => i.hard).map(i => i.key),
    ['artwork', 'board_available']);
});

test('green: a fully ready job is green at 100% with nothing to say', () => {
  const l = light();
  assert.equal(l.light, 'green');
  assert.equal(l.pct, 100);
  assert.deepEqual(l.blockers, []);
  assert.equal(l.overridden, false);
  assert.equal(l.override, null);
});

test('missing input never throws — an unbuilt job reads red, not crashed', () => {
  const l = readinessLight();
  assert.equal(l.light, 'red');
  assert.ok(l.blockers.length);
});

// ── artwork ───────────────────────────────────────────────────────────
test('artwork: unlocked artwork is the tooling-independent hard stop — red', () => {
  const l = light({ gates: { artwork: false } });
  assert.equal(byKey(l).artwork.state, 'blocked');
  assert.equal(l.light, 'red');
  assert.deepEqual(l.blockers, ['Artwork not locked']);
});

// ── board_available ───────────────────────────────────────────────────
test('board: in stock is ok', () => {
  assert.equal(byKey(light()).board_available.state, 'ok');
});

test('board: short WITH supply on order is pending — the plant runs these', () => {
  const l = light({ gates: { material: false, material_pending: true, available_sheets: 40 } });
  const it = byKey(l).board_available;
  assert.equal(it.state, 'pending');
  assert.match(it.note, /on order/);
  assert.match(it.note, /60 parent sheets/);
  assert.equal(l.light, 'amber');
});

test('board: short with NOTHING on order is blocked, shortfall named', () => {
  const l = light({ gates: { material: false, material_pending: false, available_sheets: 40 } });
  const it = byKey(l).board_available;
  assert.equal(it.state, 'blocked');
  assert.match(it.note, /short by 60 parent sheets/);
  assert.equal(l.light, 'red');
  assert.deepEqual(l.blockers, [it.note]);
});

test('board: a float hair never prints "short by 0" — qty columns are DOUBLE PRECISION', () => {
  const l = light({ gates: { material: false, material_pending: false, parent_needed: 100, available_sheets: 99.9999999 } });
  assert.match(byKey(l).board_available.note, /short by 1 parent sheets/);
});

// ── board_available: multi-board mix ───────────────────────────────────
// gates.mix_active/mix_balance are new fields on readiness()'s return; every
// existing test above omits them entirely (mkGates never sets them), so those
// tests already double as the "no mix at all" parity case — mix_active reads
// undefined, which is exactly as falsy as the `false` readiness() now always
// sends for a plain job. This block only has to prove the explicit boundary
// and the three mix-active cases beside it.
test('board: mix_active explicitly false is byte-identical to no mix info at all', () => {
  const withFlag = light({ gates: { material: false, material_pending: false, available_sheets: 40, mix_active: false } });
  const withoutFlag = light({ gates: { material: false, material_pending: false, available_sheets: 40 } });
  assert.deepEqual(withFlag, withoutFlag);
});

test('board: a fully covered mix is green — the light must never contradict the gate beside it', () => {
  const l = light({ gates: {
    material: true, material_pending: false, mix_active: true, mix_balance: 0, mix_rows: 2,
  } });
  assert.equal(byKey(l).board_available.state, 'ok');
  assert.equal(l.light, 'green');
});

test('board: an unbalanced mix is blocked and names the planning gap a planner can act on', () => {
  const l = light({ gates: {
    material: false, material_pending: false, mix_active: true, mix_balance: 1500,
    parent_needed: 4000, available_sheets: 2500,
  } });
  const it = byKey(l).board_available;
  assert.equal(it.state, 'blocked');
  assert.match(it.note, /covers 2500 of 4000 parent sheets/);
  assert.match(it.note, /allocate the remaining 1500/);
  assert.equal(l.light, 'red');
});

// An unbalanced mix is a planning gap, never a stock one — createJobCardForLine
// hard-blocks it regardless of material_pending (Task 6), so the light must
// never show 'pending' here either, even if a caller somehow set the flag.
test('board: an unbalanced mix is never "pending", even if material_pending were set', () => {
  const l = light({ gates: {
    material: false, material_pending: true, mix_active: true, mix_balance: 1500,
    parent_needed: 4000, available_sheets: 2500,
  } });
  assert.equal(byKey(l).board_available.state, 'blocked');
});

test('board: an unbalanced mix still ceils a fractional shortfall up to a whole sheet', () => {
  const l = light({ gates: {
    material: false, material_pending: false, mix_active: true, mix_balance: 1499.2,
    parent_needed: 4000, available_sheets: 2500,
  } });
  assert.match(byKey(l).board_available.note, /allocate the remaining 1500/);
});

test('board: mix float hair (a tiny positive residue) reads as balanced, not "allocate the remaining" a fraction of a sheet', () => {
  const l = light({ gates: {
    material: false, material_pending: false, mix_active: true, mix_balance: 3e-9,
    parent_needed: 4000, available_sheets: 2500,
  } });
  const it = byKey(l).board_available;
  assert.doesNotMatch(it.note, /allocate the remaining/);
  assert.match(it.note, /re-check the mix/);
});

test('board: mix float hair the other way (a tiny negative residue) also reads as balanced', () => {
  const l = light({ gates: {
    material: false, material_pending: false, mix_active: true, mix_balance: -3e-9,
    parent_needed: 4000, available_sheets: 2500,
  } });
  assert.match(byKey(l).board_available.note, /re-check the mix/);
});

test('board: a balanced mix short on stock is blocked and never invents a "short by 0"', () => {
  const l = light({ gates: {
    material: false, material_pending: false, mix_active: true, mix_balance: 0,
    parent_needed: 4000, available_sheets: 2500,
  } });
  const it = byKey(l).board_available;
  assert.equal(it.state, 'blocked');
  assert.doesNotMatch(it.note, /short by 0/);
  assert.doesNotMatch(it.note, /\bzero\b/i);
  assert.match(it.note, /re-check the mix/);
  assert.equal(l.light, 'red');
});

test('board: a balanced mix short on stock but with real incoming is pending, not blocked, and still names no number', () => {
  const l = light({ gates: {
    material: false, material_pending: true, mix_active: true, mix_balance: 0,
    parent_needed: 4000, available_sheets: 2000,
  } });
  const it = byKey(l).board_available;
  assert.equal(it.state, 'pending');
  assert.doesNotMatch(it.note, /short by 0/);
  assert.match(it.note, /on order/);
  assert.equal(l.light, 'amber');
});

// ── board_cut ─────────────────────────────────────────────────────────
test('cut: a completed cutting stage is ok', () => {
  assert.equal(byKey(light({ cuttingStatus: 'completed' })).board_cut.state, 'ok');
});

test('cut: no cutting stage on the route is na, and drops out of the percentage', () => {
  const l = light({ cuttingStatus: null });
  assert.equal(byKey(l).board_cut.state, 'na');
  assert.equal(byKey(l).board_cut.tracked, false);
  assert.equal(l.light, 'green');
  assert.equal(l.pct, 100);          // never held below 100 by a stage it never had
});

test('cut: anything short of completed is pending, never blocked', () => {
  for (const status of ['pending', 'in_progress', 'partially_completed', 'hold']) {
    const l = light({ cuttingStatus: status });
    assert.equal(byKey(l).board_cut.state, 'pending', status);
    assert.equal(l.light, 'amber', status);
  }
});

// ── plate / die ───────────────────────────────────────────────────────
const dieStatus = status => light({
  gates: { tooling_detail: [{ family: 'die', label: 'Die', hard: true, status, code: status === 'missing' ? null : 'DIE-0001' }] },
});

test('THE DIE RULE: a die that is missing or not ready is PENDING, never blocked', () => {
  // createJobCardForLine puts tooling in pending[], not blocked[] — the plant
  // pushes and runs these jobs daily. Painting the die red would tell an
  // operator "cannot proceed" about work that proceeds. If this test fails
  // because someone "fixed" the die into a blocker, the fix is the bug.
  for (const status of ['missing', 'not_ready']) {
    const l = dieStatus(status);
    assert.equal(byKey(l).die.state, 'pending', status);
    assert.notEqual(byKey(l).die.state, 'blocked', status);
    assert.equal(byKey(l).die.hard, false, status);
    assert.equal(l.light, 'amber', status);
    assert.deepEqual(l.blockers, [], status);
  }
});

test('die: a ready die is ok; a missing one says it is not registered', () => {
  assert.equal(byKey(dieStatus('ready')).die.state, 'ok');
  assert.equal(byKey(dieStatus('missing')).die.note, 'not registered');
  assert.match(byKey(dieStatus('not_ready')).die.note, /not ready \(DIE-0001\)/);
});

test('plate: reads its own family, same three states', () => {
  const plate = status => byKey(light({
    gates: { tooling_detail: [{ family: 'plate', label: 'Plate Set', hard: false, status, code: 'PLT-0001' }] },
  })).plate;
  assert.equal(plate('ready').state, 'ok');
  assert.equal(plate('not_ready').state, 'pending');
  assert.equal(plate('missing').state, 'pending');
});

test('tooling: a family this product does not need at all is na', () => {
  const l = light({ gates: { tooling_detail: [] } });
  assert.equal(byKey(l).die.state, 'na');
  assert.equal(byKey(l).plate.state, 'na');
  assert.equal(byKey(l).die.tracked, false);
});

test('tooling_ok: planning accepting a bad die never turns the row green', () => {
  // tooling_ok is the ABSOLUTE override of the tooling gate, so the job passes
  // planning with no die. Ticking the row green is how an operator ends up at
  // a press with nothing to cut with.
  const l = light({
    gates: { tooling_detail: [{ family: 'die', label: 'Die', hard: true, status: 'missing', code: null }] },
    toolingOk: 1,
  });
  const it = byKey(l).die;
  assert.equal(it.state, 'pending');
  assert.match(it.note, /not registered/);          // the real state survives
  assert.match(it.note, /accepted by planning/);    // …and says who waved it through
  assert.equal(l.light, 'amber');
});

test('tooling_ok: a genuinely ready family gains no apology note', () => {
  assert.equal(byKey(light({ toolingOk: 1 })).die.note, null);
});

// ── shade ─────────────────────────────────────────────────────────────
test('shade: no card registered is na — nothing to enforce', () => {
  const l = light({ shade: null });
  assert.equal(byKey(l).shade.state, 'na');
  assert.equal(l.light, 'green');
});

test('shade: an eligible card is ok', () => {
  assert.equal(byKey(light()).shade.state, 'ok');
});

test('shade: an ineligible card is AMBER and carries the reason — a loud warning, not a refusal', () => {
  const reason = 'Shade card SC-0007 is Rejected — production must not use it';
  const l = light({ shade: { eligible: false, reason } });
  assert.equal(byKey(l).shade.state, 'pending');
  assert.equal(byKey(l).shade.note, reason);
  assert.equal(l.light, 'amber');
  // It must still SAY it — softening the gate must never soften the message.
  // The reason rides the item's note, which is what the popover reads.
  assert.equal(byKey(l).shade.note, reason);
  assert.deepEqual(l.blockers, []);
});

test('shade: an unapproved card warns in amber and never blocks the press', () => {
  const v = readinessLight({
    gates: { artwork: 1, material: true, tooling_detail: [] },
    cuttingStatus: 'completed', machineId: 3, finalisedAt: '2026-07-01',
    shade: { eligible: false, reason: 'Shade card CI-SC-0001 is Sent to Customer — the customer must approve it before printing' },
  });
  assert.equal(v.light, 'amber');
  assert.match(v.items.find(i => i.key === 'shade').note, /must approve it before printing/);
  assert.deepEqual(v.blockers, []);
});

// ── ink ───────────────────────────────────────────────────────────────
test('ink: never tracked — no ink stock exists in the ERP, and green would be a fiction', () => {
  const it = byKey(light()).ink;
  assert.equal(it.state, 'na');
  assert.equal(it.tracked, false);
  assert.match(it.note, /not tracked/);
  // …and it must never cap the plant below 100%.
  assert.equal(light({ cuttingStatus: null }).pct, 100);
});

// ── machine / released ────────────────────────────────────────────────
test('machine: unassigned is pending', () => {
  const l = light({ machineId: null });
  assert.equal(byKey(l).machine.state, 'pending');
  assert.equal(l.light, 'amber');
});

test('released: an unfinalised job is pending', () => {
  const l = light({ finalisedAt: null });
  assert.equal(byKey(l).released.state, 'pending');
  assert.equal(l.light, 'amber');
});

// ── percentage + light rule ───────────────────────────────────────────
test('pct: ok ÷ tracked, rounded — na rows leave the denominator', () => {
  // die missing + no machine ⇒ 6 of 8 tracked (ink is na) = 75%.
  const l = light({
    gates: { tooling_detail: [
      { family: 'die', label: 'Die', hard: true, status: 'missing', code: null },
      { family: 'plate', label: 'Plate Set', hard: false, status: 'ready', code: 'PLT-0001' },
    ] },
    machineId: null,
  });
  assert.equal(l.items.filter(i => i.tracked).length, 8);
  assert.equal(l.pct, 75);
});

test('pct: rounds rather than truncates', () => {
  // artwork blocked + no machine + no press-ready die ⇒ 5 of 8 = 62.5 → 63.
  const l = light({
    gates: { artwork: false, tooling_detail: [
      { family: 'die', label: 'Die', hard: true, status: 'not_ready', code: 'DIE-0001' },
      { family: 'plate', label: 'Plate Set', hard: false, status: 'ready', code: 'PLT-0001' },
    ] },
    machineId: null,
  });
  assert.equal(l.pct, 63);
});

test('light: blocked outranks pending — red beats amber', () => {
  const l = light({ gates: { artwork: false }, machineId: null });
  assert.equal(l.light, 'red');
  assert.ok(l.items.some(i => i.state === 'pending'));
});

// ── override ──────────────────────────────────────────────────────────
const OVERRIDE = { on: 1, by: 'Dharminder', at: '2026-07-30T06:00:00Z', reason: 'Die coming off CI-2 in 20 min' };

test('override: a supervisor forces green and is named', () => {
  const l = light({ machineId: null, override: OVERRIDE });
  assert.equal(l.light, 'green');
  assert.equal(l.overridden, true);
  assert.deepEqual(l.override, OVERRIDE);
});

test('override: the checklist underneath still tells the truth', () => {
  const l = light({ machineId: null, override: OVERRIDE });
  assert.equal(byKey(l).machine.state, 'pending');
  assert.ok(l.pct < 100);
});

test('override: an overridden job with a hard blocker STILL lists that blocker', () => {
  // Green means "this press run may start", never "nothing is wrong" — the
  // banner has to be able to name what was waved through.
  const l = light({ gates: { artwork: false }, override: OVERRIDE });
  assert.equal(l.light, 'green');
  assert.deepEqual(l.blockers, ['Artwork not locked']);
  assert.equal(byKey(l).artwork.state, 'blocked');
});

test('override: a switched-off override is no override at all', () => {
  const l = light({ machineId: null, override: { on: 0, by: 'Dharminder', at: null, reason: 'stale' } });
  assert.equal(l.light, 'amber');
  assert.equal(l.overridden, false);
  assert.equal(l.override, null);
});

// ── lightForJobCards ──────────────────────────────────────────────────
const recentDate = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);

// A fake `oc`: one row back per query, exactly like db.js's one().
function fakeOc({ cut = [], shade = [] } = {}) {
  const calls = [];
  const oc = async (text, params) => {
    calls.push({ text, params });
    if (/job_stages/.test(text)) return { list: cut };
    if (/shade_cards/.test(text)) return { list: shade };
    throw new Error(`unexpected query: ${text}`);
  };
  return { oc, calls };
}

test('batch: one query per fact for the whole page, never one per card', async () => {
  const cards = Array.from({ length: 40 }, (_, i) => ({ id: i + 1, product_id: 100 + (i % 4) }));
  const { oc, calls } = fakeOc();
  const map = await lightForJobCards(cards, oc);
  assert.equal(calls.length, 2, 'a query per card is what this helper exists to prevent');
  for (const c of calls) assert.match(c.text, /= ANY\(\$1\)/);
  assert.equal(map.size, 40);
});

test('batch: ids and product ids go over as deduped arrays', async () => {
  const { oc, calls } = fakeOc();
  await lightForJobCards([{ id: 5, product_id: 9 }, { id: 5, product_id: 9 }, { id: 6, product_id: 9 }], oc);
  assert.deepEqual(calls[0].params, [[5, 6]]);
  assert.deepEqual(calls[1].params, [[9]]);
});

test('batch: cutting status lands on its own card; a card with no cutting stage gets null', async () => {
  const { oc } = fakeOc({ cut: [
    { job_card_id: 1, status: 'completed' },
    { job_card_id: 2, status: 'partially_completed' },
  ] });
  const map = await lightForJobCards([{ id: 1, product_id: 7 }, { id: 2, product_id: 7 }, { id: 3, product_id: 7 }], oc);
  assert.equal(map.get(1).cuttingStatus, 'completed');
  assert.equal(map.get(2).cuttingStatus, 'partially_completed');
  assert.equal(map.get(3).cuttingStatus, null);   // gang child — no cutting on its route
});

test('batch: shade eligibility is decided per product, from the newest live card', async () => {
  const { oc } = fakeOc({ shade: [
    { product_id: 10, sc_number: 'SC-0010', status: 'rejected', creation_date: recentDate, active: 1 },
    { product_id: 11, sc_number: 'SC-0011', status: 'approved', creation_date: recentDate, active: 1 },
  ] });
  const map = await lightForJobCards(
    [{ id: 1, product_id: 10 }, { id: 2, product_id: 11 }, { id: 3, product_id: 13 }], oc);

  assert.equal(map.get(1).shade.eligible, false);       // rejected card — a real red
  assert.equal(map.get(2).shade.eligible, true);
  assert.equal(map.get(3).shade, null);                 // no card registered — na, not a failure
});

test('batch: the two inputs feed straight into the light', async () => {
  const { oc } = fakeOc({ cut: [{ job_card_id: 1, status: 'in_progress' }] });
  const map = await lightForJobCards([{ id: 1, product_id: 7 }], oc);
  const l = light(map.get(1));
  assert.equal(byKey(l).board_cut.state, 'pending');
  assert.equal(byKey(l).shade.state, 'na');
  assert.equal(l.light, 'amber');
});

test('batch: nothing to load means no queries at all', async () => {
  const { oc, calls } = fakeOc();
  assert.equal((await lightForJobCards([], oc)).size, 0);
  assert.equal((await lightForJobCards(null, oc)).size, 0);
  assert.equal(calls.length, 0);
});

test('batch: cards without a product skip the shade query but still get a row', async () => {
  const { oc, calls } = fakeOc({ cut: [{ job_card_id: 1, status: 'completed' }] });
  const map = await lightForJobCards([{ id: 1, product_id: null }], oc);
  assert.equal(calls.length, 1);
  assert.deepEqual(map.get(1), { cuttingStatus: 'completed', shade: null });
});
