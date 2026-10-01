import test from 'node:test';
import assert from 'node:assert/strict';
import {
  JOIN_STAGES, partStages, assemblyStages, shouldJoinAtDieCut, partPieces, joinableSets,
  walkToInProduction, partsFrozen, partLineSyncPlan, partsChangeBlock, partLineGangBlock,
  cartonLineBlock, partsSetError, lineSays, partSays, pastingCantStart, partStillReferenced,
  cartonPrintState,
} from './carton-parts.js';
import { routingFor } from './helpers.js';

const ROUTE = [
  { stage: 'cutting', unit: 'sheets' }, { stage: 'printing', unit: 'sheets' },
  { stage: 'die_cutting', unit: 'sheets' }, { stage: 'sorting', unit: 'cartons' },
  { stage: 'pasting', unit: 'cartons' },
];

test('a part runs to die cutting; the pasting card runs sorting + pasting', () => {
  assert.deepEqual(JOIN_STAGES, ['sorting', 'pasting']);
  assert.deepEqual(partStages(ROUTE).map(s => s.stage), ['cutting', 'printing', 'die_cutting']);
  assert.deepEqual(assemblyStages(ROUTE).map(s => s.stage), ['sorting', 'pasting']);
});

test('a part route ENDS at die cutting even if a stage ever follows pasting', () => {
  const withQc = [...ROUTE, { stage: 'qc', unit: 'cartons' }];
  assert.equal(partStages(withQc).at(-1).stage, 'die_cutting');
  assert.throws(() => partStages([{ stage: 'cutting' }, { stage: 'printing' }]), /no die cutting stage/);
});

test('over the real routingFor: the part ends at die cutting and part + pasting cover the route', () => {
  const specs = [{}, { coating: 'Full UV Coating' }, { coating: 'Thermal Lamination (Matte)' },
    { leafing: 1 }, { emboss: 1 }, { coating: 'Full UV Coating', emboss: 1, leafing: 1 }];
  for (const spec of specs) {
    const route = routingFor(spec);
    const part = partStages(route);
    assert.equal(part.at(-1).stage, 'die_cutting', JSON.stringify(spec));
    assert.deepEqual([...part, ...assemblyStages(route)].map(s => s.stage), route.map(s => s.stage), JSON.stringify(spec));
  }
});

test('only the LAST die cutting of a PART line joins', () => {
  assert.equal(shouldJoinAtDieCut({ isLastStage: true, stage: 'die_cutting', partOfLineId: 950 }), true);
  assert.equal(shouldJoinAtDieCut({ isLastStage: true, stage: 'die_cutting', partOfLineId: null }), false);
  assert.equal(shouldJoinAtDieCut({ isLastStage: false, stage: 'die_cutting', partOfLineId: 950 }), false);
  assert.equal(shouldJoinAtDieCut({ isLastStage: true, stage: 'printing', partOfLineId: 950 }), false);
});

test('pieces = die-cut sheets × ups, ups floors at 1', () => {
  assert.equal(partPieces({ dieCutSheets: 1450, ups: 8 }), 11600);
  assert.equal(partPieces({ dieCutSheets: 100, ups: 0 }), 100);
  assert.equal(partPieces({ dieCutSheets: null, ups: 4 }), 0);
});

test('the scarcer part decides the cartons; the rest is spare', () => {
  assert.deepEqual(joinableSets([
    { label: 'Part 1', pieces: 11800, per_carton: 1 },
    { label: 'Part 2', pieces: 11600, per_carton: 1 },
  ]), { sets: 11600, spare: [{ label: 'Part 1', qty: 200 }] });
  assert.deepEqual(joinableSets([
    { label: 'Top', pieces: 1000, per_carton: 1 },
    { label: 'Insert', pieces: 1500, per_carton: 2 },
  ]), { sets: 750, spare: [{ label: 'Top', qty: 250 }] });
  assert.deepEqual(joinableSets([]), { sets: 0, spare: [] });
});

test('a part that made nothing gives 0 cartons — the other part is all spare', () => {
  assert.deepEqual(joinableSets([
    { label: 'Part 1', pieces: 0, per_carton: 1 },
    { label: 'Part 2', pieces: 500, per_carton: 1 },
  ]), { sets: 0, spare: [{ label: 'Part 2', qty: 500 }] });
});

test('the carton line walks to in_production from where it stands', () => {
  assert.deepEqual(walkToInProduction('pending'), ['planned', 'ready', 'in_production']);
  assert.deepEqual(walkToInProduction('planned'), ['ready', 'in_production']);
  assert.deepEqual(walkToInProduction('ready'), ['in_production']);
  assert.deepEqual(walkToInProduction('in_production'), []);
  assert.throws(() => walkToInProduction('cancelled'), /cannot start pasting/);
  assert.throws(() => walkToInProduction('produced'), /The carton line is produced — it cannot start pasting/);
});

test('the die-cut operator reads why the pasting card cannot start as one sentence naming the carton', () => {
  assert.equal(pastingCantStart({ code: 'SW-715', po: '02545', status: 'cancelled' }),
    "SW-715 on PO 02545 is cancelled, so its pasting card can't start — ask Planning");
  assert.equal(pastingCantStart({ code: 'SW-715', po: '02545', status: 'dispatched' }),
    "SW-715 on PO 02545 is already dispatched, so its pasting card can't start — ask Planning");
});

test('a status is said in the plant\'s words — never "already ready"; a part reads its card too', () => {
  // 'ready' has every gate green and no card yet — a line reaches
  // in_production only when its job card is made
  assert.equal(lineSays('ready'), 'already cleared for its job card');
  assert.equal(lineSays('in_production'), 'already in production');
  assert.equal(lineSays('cancelled'), 'cancelled');
  assert.equal(partSays({ status: 'ready' }), 'already cleared for its job card');
  assert.equal(partSays({ status: 'in_production', jc_status: 'open' }), 'already in production');
  // a die-cut part is still in_production on its line (C4); its card is split
  assert.equal(partSays({ status: 'in_production', jc_status: 'split' }), 'already die-cut');
  // produced → dispatched is the walk onto the pasting card (C5)
  assert.equal(partSays({ status: 'dispatched', jc_status: 'split' }), 'already pasted');
  assert.equal(partSays({ status: 'produced', jc_status: 'split' }), 'already pasted');
});

test('a part that cannot leave because a record points at it is named in plain words', () => {
  assert.equal(partStillReferenced('Part 1', 'shade_cards'), 'Part 1 has a shade card raised against it');
  assert.equal(partStillReferenced('Part 1', 'some_register'), 'other records still point at Part 1');
});

test('Print Status of a carton made in parts is read off its parts\' printing', () => {
  assert.equal(cartonPrintState([]), null);
  assert.equal(cartonPrintState([null, null]), null, 'no part carded: Not started');
  assert.equal(cartonPrintState(['pending', null]), 'pending', 'a part carded, none printing: Queued');
  assert.equal(cartonPrintState(['completed', null]), 'partially_completed', 'Part 1 printed, Part 2 not: Partial');
  assert.equal(cartonPrintState(['completed', 'pending']), 'partially_completed');
  assert.equal(cartonPrintState(['partially_completed', 'pending']), 'partially_completed');
  assert.equal(cartonPrintState(['completed', 'in_progress']), 'in_progress', 'a part printing now: Running');
  assert.equal(cartonPrintState(['hold', 'pending']), 'hold');
  // Progress outranks a hold: a part already printed says Partial even while
  // another part's printing is held; a part printing now says Running.
  assert.equal(cartonPrintState(['completed', 'hold']), 'partially_completed', 'printed + held: Partial');
  assert.equal(cartonPrintState(['in_progress', 'hold']), 'in_progress', 'printing + held: Running');
  assert.equal(cartonPrintState(['completed', 'completed']), 'completed', 'every part printed: Done');
});

const PARTS = [
  { part_product_id: 11, label: 'Part 1', per_carton: 1 },
  { part_product_id: 12, label: 'Part 2', per_carton: 1 },
];
// A part line as partLinesOf() returns it: it remembers its own label and pieces per carton.
const line = (id, product_id, status, qty = 100, line_remark = null, part_per_carton = 1) => {
  const label = product_id === 11 ? 'Part 1' : product_id === 12 ? 'Part 2' : 'Part 2b';
  return { id, product_id, status, qty, line_remark, part_label: label, part_per_carton, label };
};

test('frozen = any part past planning', () => {
  assert.equal(partsFrozen([line(1, 11, 'pending'), line(2, 12, 'planned')]), false);
  assert.equal(partsFrozen([line(1, 11, 'pending'), line(2, 12, 'ready')]), true);
  assert.equal(partsFrozen([]), false);
});

test('sync: a fresh carton line gets one part line per part, qty × per carton', () => {
  const plan = partLineSyncPlan({ outer: { qty: 11500, status: 'pending', line_remark: 'B-7' },
    parts: [PARTS[0], { ...PARTS[1], per_carton: 2 }], existing: [] });
  assert.deepEqual(plan.insert, [
    { product_id: 11, qty: 11500, label: 'Part 1', per_carton: 1 },
    { product_id: 12, qty: 23000, label: 'Part 2', per_carton: 2 },
  ]);
  assert.deepEqual([plan.update, plan.remove, plan.warnings], [[], [], []]);
});

test('sync: a planned carton still syncs; nothing changed means nothing to do', () => {
  assert.equal(partLineSyncPlan({ outer: { qty: 100, status: 'planned' }, parts: PARTS, existing: [] }).insert.length, 2);
  assert.deepEqual(partLineSyncPlan({ outer: { qty: 100, status: 'pending', line_remark: null }, parts: PARTS,
    existing: [line(1, 11, 'planned'), line(2, 12, 'pending')] }), { insert: [], update: [], remove: [], warnings: [] });
});

test('sync: qty and batch follow onto parts still in planning; past it they warn by name', () => {
  const plan = partLineSyncPlan({
    outer: { qty: 12000, status: 'pending', line_remark: 'B-8' }, parts: PARTS,
    existing: [line(1, 11, 'planned', 11500, 'B-7'), line(2, 12, 'in_production', 11500, 'B-7')],
  });
  assert.deepEqual(plan.update, [{ id: 1, qty: 12000, line_remark: 'B-8', label: 'Part 1', per_carton: 1 }]);
  assert.deepEqual(plan.warnings, [
    'Part 2 is already in production, so its quantity stays at 11,500 — to change it, roll the carton back in Planning and save this order again',
    'Part 2 is already in production, so it keeps batch B-7, not B-8 — to change it, roll the carton back in Planning and save this order again',
  ]);
});

test('sync: once a part is die-cut, no warning offers a rollback — none can take the carton back', () => {
  const diecut = { ...line(2, 12, 'in_production', 11500, 'B-7'), jc_status: 'split' };
  const plan = partLineSyncPlan({
    outer: { qty: 12000, status: 'pending', line_remark: 'B-7' }, parts: PARTS,
    existing: [line(1, 11, 'ready', 11500, 'B-7'), diecut],
  });
  assert.deepEqual(plan.warnings, [
    'Part 1 is already cleared for its job card, so its quantity stays at 11,500',
    'Part 2 is already die-cut, so its quantity stays at 11,500',
  ]);
  const list = partLineSyncPlan({ outer: { qty: 100, status: 'pending', line_remark: null }, parts: PARTS.slice(0, 1),
    existing: [line(1, 11, 'in_production'), { ...line(2, 12, 'in_production'), jc_status: 'split' }] });
  assert.deepEqual(list.warnings, ['This carton is already under way as Part 1 + Part 2 — a changed parts list applies from the next order']);
});

test('sync: a batch-only change on a part still in planning is an update', () => {
  const plan = partLineSyncPlan({ outer: { qty: 100, status: 'pending', line_remark: 'B-9' }, parts: PARTS,
    existing: [line(1, 11, 'pending', 100, 'B-7'), line(2, 12, 'pending', 100, 'B-9')] });
  assert.deepEqual(plan.update, [{ id: 1, qty: 100, line_remark: 'B-9', label: 'Part 1', per_carton: 1 }]);
});

test('sync: a part dropped from the master leaves while in planning — pending or planned', () => {
  const plan = partLineSyncPlan({
    outer: { qty: 100, status: 'pending', line_remark: null }, parts: PARTS.slice(0, 1),
    existing: [line(1, 11, 'pending'), line(2, 12, 'planned')],
  });
  assert.deepEqual(plan.remove, [{ id: 2 }]);
  assert.deepEqual(plan.warnings, []);
});

test('sync: once a part is on the floor the parts LIST is frozen — no adds, no removes, one warning', () => {
  // (a) Part 2 replaced by Part 2b on the master while Part 1 is printing
  const swapped = partLineSyncPlan({
    outer: { qty: 100, status: 'pending', line_remark: null },
    parts: [PARTS[0], { part_product_id: 13, label: 'Part 2b', per_carton: 1 }],
    existing: [line(1, 11, 'in_production'), line(2, 12, 'planned')],
  });
  assert.deepEqual([swapped.insert, swapped.remove], [[], []]);
  assert.deepEqual(swapped.warnings,
    ['This carton is already under way as Part 1 + Part 2 — a changed parts list applies from the next order, or to this one once the carton is rolled back in Planning and this order saved again']);
  // (b) the parts list cleared after Part 1 was die-cut: its lines stay
  const cleared = partLineSyncPlan({ outer: { qty: 100, status: 'pending', line_remark: null }, parts: [],
    existing: [line(1, 11, 'in_production'), line(2, 12, 'in_production')] });
  assert.deepEqual([cleared.insert, cleared.remove, cleared.warnings.length], [[], [], 1]);
});

test('sync: while frozen, a part the master dropped but still in planning keeps following qty and batch', () => {
  const plan = partLineSyncPlan({
    outer: { qty: 12000, status: 'pending', line_remark: 'B-8' }, parts: PARTS.slice(0, 1),
    existing: [line(1, 11, 'in_production', 12000, 'B-8'), line(2, 12, 'planned', 11500, 'B-7')],
  });
  assert.deepEqual(plan.update, [{ id: 2, qty: 12000, line_remark: 'B-8', label: 'Part 2', per_carton: 1 }]);
  assert.deepEqual([plan.insert, plan.remove], [[], []]);
  assert.equal(plan.warnings.length, 1);
  assert.match(plan.warnings[0], /already under way as Part 1 \+ Part 2/);
});

test('sync: a part the master dropped keeps its OWN label and pieces per carton while it follows', () => {
  // not frozen: it follows the carton (qty 150 × its own 2) and is removed; if the
  // removal is refused the kept line is still right-sized
  const plan = partLineSyncPlan({
    outer: { qty: 150, status: 'pending', line_remark: null }, parts: PARTS.slice(0, 1),
    existing: [line(1, 11, 'pending', 150), line(2, 12, 'planned', 200, null, 2)],
  });
  assert.deepEqual(plan.update, [{ id: 2, qty: 300, line_remark: null, label: 'Part 2', per_carton: 2 }]);
  assert.deepEqual(plan.remove, [{ id: 2 }]);
});

test('sync: while nothing is under way, a listed part takes the master\'s new pieces per carton', () => {
  const plan = partLineSyncPlan({
    outer: { qty: 100, status: 'pending', line_remark: null },
    parts: [{ ...PARTS[0], per_carton: 2 }, PARTS[1]],
    existing: [line(1, 11, 'pending'), line(2, 12, 'planned')],
  });
  assert.deepEqual(plan.update, [{ id: 1, qty: 200, line_remark: null, label: 'Part 1', per_carton: 2 }]);
});

test('sync: once frozen, the order\'s own pieces per carton stand even if the master changes', () => {
  const plan = partLineSyncPlan({
    outer: { qty: 100, status: 'pending', line_remark: null },
    parts: [{ ...PARTS[0], per_carton: 2 }, { ...PARTS[1], label: 'Base' }],
    existing: [line(1, 11, 'in_production'), line(2, 12, 'planned')],
  });
  assert.deepEqual(plan, { insert: [], update: [], remove: [], warnings: [] });
});

test('sync: string ids from JSON compare as numbers', () => {
  const plan = partLineSyncPlan({ outer: { qty: 100, status: 'pending', line_remark: null },
    parts: [{ part_product_id: '11', label: 'Part 1', per_carton: 1 }, { part_product_id: '12', label: 'Part 2', per_carton: 1 }],
    existing: [line(1, 11, 'pending'), line(2, 12, 'pending')] });
  assert.deepEqual(plan, { insert: [], update: [], remove: [], warnings: [] });
});

test('sync: a carton line past planning is never touched', () => {
  const plan = partLineSyncPlan({ outer: { qty: 100, status: 'in_production' }, parts: PARTS, existing: [] });
  assert.deepEqual(plan, { insert: [], update: [], remove: [], warnings: [] });
});

test('change guard: a part never moves alone; a carton not once a part is past planning', () => {
  assert.match(partsChangeBlock({ part_of_line_id: 950 }), /one part of a carton made in parts — cancel or remove the carton, not its part/);
  // while no part is die-cut the way out is real: roll the whole carton back, then cancel
  assert.equal(partsChangeBlock({ id: 950 }, [{ label: 'Part 2', status: 'ready' }]),
    'Part 2 of this carton is already cleared for its job card — roll the carton back in Planning first, then cancel it');
  assert.equal(partsChangeBlock({ id: 950 }, [{ label: 'Part 1', status: 'in_production', jc_status: 'open' }]),
    'Part 1 of this carton is already in production — roll the carton back in Planning first, then cancel it');
  // a die-cut or pasted part can never go back — so no rollback is offered
  assert.equal(partsChangeBlock({ id: 950 }, [{ label: 'Part 1', status: 'in_production', jc_status: 'split' }]),
    'Part 1 of this carton is already die-cut — the carton can no longer be cancelled');
  assert.equal(partsChangeBlock({ id: 950 }, [{ label: 'Part 1', status: 'dispatched', jc_status: 'split' }]),
    'Part 1 of this carton is already pasted — the carton can no longer be cancelled');
  assert.equal(partsChangeBlock({ id: 950 }, [{ label: 'Part 1', status: 'planned' }]), null);
  assert.equal(partsChangeBlock({ id: 950 }, [{ label: 'Part 1', status: 'pending' }]), null);
  assert.equal(partsChangeBlock({ id: 1 }, []), null);
});

test('change guard: the part furthest along speaks — one die-cut part and no rollback is offered', () => {
  assert.equal(partsChangeBlock({ id: 950 }, [
    { label: 'Part 1', status: 'ready' },
    { label: 'Part 2', status: 'in_production', jc_status: 'split' },
    { label: 'Part 3', status: 'in_production', jc_status: 'in_progress' },
  ]), 'Part 2 of this carton is already die-cut — the carton can no longer be cancelled');
  assert.equal(partsChangeBlock({ id: 950 }, [
    { label: 'Part 1', status: 'ready' }, { label: 'Part 2', status: 'in_production', jc_status: 'open' },
  ]), 'Part 2 of this carton is already in production — roll the carton back in Planning first, then cancel it');
});

test('gang guard names the part — and the carton itself', () => {
  assert.match(partLineGangBlock([{ product_name: 'X' }, { product_name: 'GM2 P1', part_of_line_id: 9 }]),
    /GM2 P1 is one part of a carton made in parts — it runs on its own job card, never in a gang or combined run/);
  assert.match(partLineGangBlock([{ product_name: 'GM2 OUTER', has_parts: true }, { product_name: 'X' }]),
    /GM2 OUTER is made in parts — its parts run on their own job cards/);
  assert.equal(partLineGangBlock([{ product_name: 'X' }]), null);
});

test('carton line guard — and a part at the FG doors', () => {
  assert.match(cartonLineBlock({ hasParts: true }), /made in parts — plan, cover and fill its parts, not the carton itself/);
  assert.match(cartonLineBlock({ isPart: true }), /one part of a carton made in parts — its pieces come from its own job card, never from FG stock/);
  assert.equal(cartonLineBlock({ hasParts: false }), null);
  assert.equal(cartonLineBlock({}), null);
});

test('parts set: 0 or ≥2 parts, same customer, one level, clean labels — each refusal names its row', () => {
  const outer = { id: 1, customer_id: 5 };
  const products = new Map([[11, { id: 11, customer_id: 5 }], [12, { id: 12, customer_id: 5 }], [13, { id: 13, customer_id: 6 }]]);
  const ok = { outer, products, outerIsPart: false, partsWithParts: [] };
  assert.equal(partsSetError({ ...ok, parts: [] }), null);
  assert.equal(partsSetError({ ...ok, parts: PARTS }), null);
  assert.equal(partsSetError({ ...ok, parts: PARTS.map(p => ({ ...p, part_product_id: String(p.part_product_id) })) }), null);
  assert.match(partsSetError({ ...ok, parts: PARTS.slice(0, 1) }), /at least two parts/);
  assert.match(partsSetError({ ...ok, parts: [PARTS[0], { part_product_id: 13, label: 'P', per_carton: 1 }] }),
    /^P: every part must belong to the same customer/);
  assert.match(partsSetError({ ...ok, parts: [PARTS[0], { ...PARTS[1], label: 'part 1' }] }), /^part 1: two parts have the same label/);
  assert.match(partsSetError({ ...ok, parts: [PARTS[0], { ...PARTS[1], part_product_id: 1 }] }), /^Part 2: a carton cannot be a part of itself/);
  assert.match(partsSetError({ ...ok, parts: [PARTS[0], { ...PARTS[1], per_carton: 0 }] }), /^Part 2: pieces per carton/);
  assert.match(partsSetError({ ...ok, parts: [PARTS[0], { ...PARTS[1], part_product_id: 11 }] }), /^Part 2: the same product is listed twice/);
  assert.match(partsSetError({ ...ok, parts: [PARTS[0], { ...PARTS[1], part_product_id: 99 }] }), /^Part 2: that product is not in the Product Master/);
  assert.match(partsSetError({ ...ok, parts: [PARTS[0], { ...PARTS[1], part_product_id: '' }] }), /^Part 2: pick the part's product/);
  assert.match(partsSetError({ ...ok, parts: [PARTS[0], { ...PARTS[1], label: '' }] }), /^Row 2: give the part a label/);
  assert.match(partsSetError({ ...ok, outerIsPart: true, parts: PARTS }), /is itself a part of another carton/);
  assert.match(partsSetError({ ...ok, partsWithParts: ['12'], parts: PARTS }), /^Part 2: that product has parts of its own/);
});

test('parts set: pieces per carton is capped at 1000 — a typo never becomes 11,500,000 pieces of a part', () => {
  const products = new Map([[11, { id: 11, customer_id: 5 }], [12, { id: 12, customer_id: 5 }]]);
  const ok = { outer: { id: 1, customer_id: 5 }, products, outerIsPart: false, partsWithParts: [] };
  assert.equal(partsSetError({ ...ok, parts: [PARTS[0], { ...PARTS[1], per_carton: 1000 }] }), null);
  assert.equal(partsSetError({ ...ok, parts: [PARTS[0], { ...PARTS[1], per_carton: '1000' }] }), null);
  assert.equal(partsSetError({ ...ok, parts: [PARTS[0], { ...PARTS[1], per_carton: 1001 }] }),
    'Part 2: pieces per carton must be 1000 or fewer');
  assert.equal(partsSetError({ ...ok, parts: [{ ...PARTS[0], per_carton: 11500 }, PARTS[1]] }),
    'Part 1: pieces per carton must be 1000 or fewer');
});
