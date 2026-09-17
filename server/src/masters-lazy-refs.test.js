// Masters: a tab loads the refs its own form picks from, and no others.
//
// The mount effect fetched the whole product master (1,847 KB) and the die list
// (~250 KB) whichever tab was open — Customers, Machines, Employees, Boards —
// and on the Products tab it fetched /products a SECOND time, alongside the
// tab's own load. Only the Blocks form picks a product and only the Products
// form picks a die.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TAB_REFS, refsToLoad } from '../../client/src/lib/masterRefs.js';
import { PRODUCT_MASTER_FIELDS } from '../../client/src/lib/productMasterConfig.js';

const masters = readFileSync(new URL('../../client/src/pages/Masters.jsx', import.meta.url), 'utf8');

test('each heavy ref belongs to the one tab whose form picks from it', () => {
  assert.deepEqual(TAB_REFS.blocks, [{ ref: 'products', endpoint: '/products' }]);
  assert.deepEqual(TAB_REFS.products, [{ ref: 'dies', endpoint: '/tools?family=die' }]);
  // The configs that name these refs — if another form starts picking a
  // product or a die, it has to be added to TAB_REFS or its picker is empty.
  assert.deepEqual([...masters.matchAll(/ref: 'products'/g)].length, 1, 'only Blocks picks a product');
  assert.ok(masters.split('blocks: {')[1]?.split('fields: [')[1]?.includes("ref: 'products'"));
  assert.deepEqual(PRODUCT_MASTER_FIELDS.filter(f => f.ref === 'dies').map(f => f.key), ['tool_id']);
  assert.equal(/ref: 'dies'/.test(masters), false, 'only the Products form picks a die');
});

test('a tab asks for its refs once, and a tab with none asks for nothing', () => {
  assert.deepEqual(refsToLoad('customers', new Set()), []);
  assert.deepEqual(refsToLoad('boards', new Set()), []);
  assert.deepEqual(refsToLoad('blocks', new Set()).map(x => x.ref), ['products']);
  assert.deepEqual(refsToLoad('blocks', new Set(['products'])), [], 'switching back does not refetch');
  assert.deepEqual(refsToLoad('products', new Set(['products'])).map(x => x.ref), ['dies']);
  assert.deepEqual(refsToLoad(undefined, new Set()), []);
});

test('the mount effect no longer fetches the product master or the dies', () => {
  const mount = masters.split("api.get('/customers').then(")[1]?.split('}, []);')[0] ?? '';
  assert.ok(mount.includes("api.get('/materials')"), 'the mount effect must be found');
  assert.equal(mount.includes("api.get('/products')"), false, 'the 1.8 MB master loads on Blocks only');
  assert.equal(mount.includes('/tools?family=die'), false, 'the dies load on Products only');
  assert.ok(masters.includes('refsToLoad(tab,'), 'refs load on tab entry (including a ?tab= deep link)');
});
