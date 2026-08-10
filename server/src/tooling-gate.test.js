import test from 'node:test';
import assert from 'node:assert/strict';
import { requiredFamilies, toolReady, toolingDetail, toolingGateOk, TOOL_FAMILIES, TOOL_ZONES } from './tooling-gate.js';

const mkTool = (over = {}) => ({
  id: 1, family: 'die', code: 'DIE-0001', title: 'Test die', product_id: 10,
  zone: 'in_rack', condition: 'Good', active: 1, ...over,
});

test('requiredFamilies: plain product needs die and plate — no block, no shade card', () => {
  // Shade cards moved to the Shade Card Management module (2026-07-15).
  assert.deepEqual(requiredFamilies({ special: 'none' }), ['die', 'plate']);
});

test('requiredFamilies: foil/emboss products also need a block', () => {
  for (const special of ['foil', 'emboss', 'foil_emboss']) {
    assert.ok(requiredFamilies({ special }).includes('block'), special);
  }
});

test('toolReady: ready only when active, healthy and in rack / on floor', () => {
  assert.equal(toolReady(mkTool()), true);
  assert.equal(toolReady(mkTool({ zone: 'on_floor' })), true);
  assert.equal(toolReady(mkTool({ zone: 'making' })), false);
  assert.equal(toolReady(mkTool({ zone: 'incoming' })), false);
  assert.equal(toolReady(mkTool({ condition: 'Poor' })), false);
  assert.equal(toolReady(mkTool({ condition: 'Scrapped' })), false);
  assert.equal(toolReady(mkTool({ active: 0 })), false);
  assert.equal(toolReady(null), false);
});

test('toolingDetail: statuses per family — ready / not_ready / missing', () => {
  const product = { id: 10, special: 'foil', tool_id: 1 };
  const tools = [
    mkTool(),                                                        // die ready
    mkTool({ id: 2, family: 'plate', code: 'PLT-0001', zone: 'making' }), // plate at maker
    // no block
  ];
  const d = toolingDetail(product, tools);
  const by = Object.fromEntries(d.map(x => [x.family, x]));
  assert.equal(by.die.status, 'ready');
  assert.equal(by.die.hard, true);
  assert.equal(by.plate.status, 'not_ready');
  assert.equal(by.plate.zone, 'making');
  assert.equal(by.block.status, 'missing');
  assert.equal(by.die.code, 'DIE-0001');
});

test('toolingDetail: die matched via products.tool_id link, not just product_id', () => {
  // Real migrated dies have product_id NULL — the product points at them.
  const product = { id: 10, special: 'none', tool_id: 7 };
  const d = toolingDetail(product, [mkTool({ id: 7, product_id: null })]);
  assert.equal(d.find(x => x.family === 'die').status, 'ready');
});

test('gate: hard die must be ready; missing soft families never block', () => {
  const product = { id: 10, special: 'none', tool_id: 1 };
  // die ready, plate untracked → gate passes
  assert.equal(toolingGateOk(toolingDetail(product, [mkTool()]), 0), true);
  // die missing → gate fails
  assert.equal(toolingGateOk(toolingDetail(product, []), 0), false);
  // die at vendor → gate fails
  assert.equal(toolingGateOk(toolingDetail(product, [mkTool({ zone: 'making' })]), 0), false);
});

test('gate: a registered BLOCK that is not ready still blocks', () => {
  // Unchanged: an emboss block at the maker is a real reason to hold a line.
  const product = { id: 10, special: 'emboss', tool_id: 1 };
  const tools = [mkTool(), mkTool({ id: 2, family: 'block', code: 'BLK-0001', zone: 'making' })];
  assert.equal(toolingGateOk(toolingDetail(product, tools), 0), false);
  // …and passes once the block reaches the rack
  tools[1].zone = 'in_rack';
  assert.equal(toolingGateOk(toolingDetail(product, tools), 0), true);
});

test('gate: a plate at the maker does NOT block, where a block would', () => {
  // The one family carved out. Same shape, same zone, opposite verdict — a plate
  // set still being made is told to the floor, never enforced against it.
  const product = { id: 10, special: 'none', tool_id: 1 };
  const tools = [mkTool(), mkTool({ id: 2, family: 'plate', code: 'PLT-0001', zone: 'making' })];
  assert.equal(toolingGateOk(toolingDetail(product, tools), 0), true);
});

test('gate: manual tooling_ok override is absolute', () => {
  assert.equal(toolingGateOk(toolingDetail({ id: 10, special: 'none', tool_id: null }, []), 1), true);
});

test('constants: three families with prefixes, four zones', () => {
  assert.deepEqual(Object.keys(TOOL_FAMILIES), ['die', 'plate', 'block']);
  assert.deepEqual(TOOL_ZONES, ['incoming', 'making', 'in_rack', 'on_floor']);
  assert.equal(TOOL_FAMILIES.plate.prefix, 'PLT-');
});
