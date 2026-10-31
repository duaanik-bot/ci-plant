// Owner, 31 Oct 2026: Fluence's rule is that nothing leaves without the new MRP
// printed on it, so the designer reads the carton's MRP off the screen while
// setting the output. products.mrp is the one figure: order lines keep no MRP
// of their own, so a PO always shows what the master says today.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mrpText } from '../../client/src/lib/mrp.js';

const read = p => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const sqlAfter = (src, marker) => src.slice(src.indexOf(marker), src.indexOf('`;', src.indexOf(marker)));

test('an MRP reads to the paisa, and a blank or zero one reads as nothing', () => {
  assert.equal(mrpText(1721), '₹1,721');
  assert.equal(mrpText('3470.00'), '₹3,470');
  assert.equal(mrpText(605.08), '₹605.08');
  assert.equal(mrpText(1720.5), '₹1,720.50');
  for (const none of [null, undefined, '', 0, 'x']) assert.equal(mrpText(none), null);
});

test('LINE_VIEW carries the master MRP — Planning and the PO both ride it', () => {
  assert.match(sqlAfter(read('server/src/routes/orders.js'), 'const LINE_VIEW'), /\bp\.mrp\b/);
});

test('every other query behind these screens carries it too', () => {
  const orders = read('server/src/routes/orders.js');
  assert.match(orders.slice(orders.indexOf('WITH demand AS ('), orders.indexOf('ol.qty, ol.dispatched_qty, (ol.qty - ol.dispatched_qty) AS pending_qty')), /\bp\.mrp\b/, 'Sales Pendency');
  const drafts = read('server/src/routes/drafts.js');
  assert.match(drafts.slice(drafts.indexOf("r.get('/drafts',"), drafts.indexOf('FROM order_lines ol JOIN products p ON p.id = ol.product_id')), /\bp\.mrp\b/, 'a PO waiting to be confirmed');
  const gangs = read('server/src/routes/gangs.js');
  assert.match(gangs.slice(gangs.indexOf('p.id AS product_id, p.name AS product_name'), gangs.indexOf('FROM order_lines ol')), /\bp\.mrp\b/, 'a gang\'s members in the planner');
});

test('every screen that names a product shows the MRP; only customer paperwork leaves it off', () => {
  const identity = read('client/src/components/ProductIdentity.jsx');
  assert.match(identity, /showMrp = true,/, 'on unless a screen says otherwise');
  for (const f of ['client/src/pages/Invoice.jsx', 'client/src/pages/Challan.jsx', 'client/src/pages/COA.jsx']) {
    const tags = read(f).match(/<ProductIdentity\b[\s\S]*?\/>/g) || [];
    assert.ok(tags.length, f);
    for (const t of tags) assert.match(t, /showMrp=\{false\}/, `${f}: goes to the customer`);
  }
  assert.match(read('client/src/components/Drafts.jsx'), /<ProductMrp value=\{l\.mrp\}/);
});

test('the job card carries it itself: a card prints at once, with no lookup to wait for', () => {
  const production = read('server/src/routes/production.js');
  const view = sqlAfter(production, 'const JC_VIEW');
  assert.match(view, /p\.mrp\b/);
  assert.match(view, /'mrp', p3\.mrp/, 'each gang member\'s own MRP');
});

test('a station queue carries it, so a tablet needs no second request', () => {
  assert.match(read('server/src/routes/floor.js'), /p\.code AS product_code, p\.party_item_code, p\.mrp,/);
});

test('a row without the MRP asks the master, and only by a real product id', () => {
  const identity = read('client/src/components/ProductIdentity.jsx');
  assert.match(identity, /const explicitId = row\?\.product_id \?\? product\?\.product_id \?\? productId/,
    'a job card row\'s own id is not a product: never price one from it');
  assert.match(identity, /showMrp && r\.mrp === undefined && explicitId != null/);
});
