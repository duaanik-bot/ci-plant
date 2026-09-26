// Kit Studio inside the ERP: how a studio document maps onto kit_studio_* rows
// and the Fluence master (kit-studio.js), and the wiring that keeps it additive.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  dim, dimsOf, sizeText, parseSizeText, sameCarton, statusOf, masterDimsFor, validId, nameKey,
  splitKit, splitProduct, splitSettings, kitDoc, productDoc,
  billingCodeOf, nextBillingCode, newProductRow, productInput, nameMatch, rankMatches, SPEC_COPIED, SPEC_SAME_CARTON,
} from './kit-studio.js';
import { nameKey as fluenceNameKey } from '../../client/src/lib/fluence.js';

const root = new URL('../../', import.meta.url);
const read = p => readFileSync(new URL(p, root), 'utf8');
const MIGRATION = 'supabase/migrations/20260926100000_kit_studio.sql';

test('sizes: numbers in, the ERP product spelling out, and back', () => {
  assert.equal(dim(''), null);
  assert.equal(dim(0), null);
  assert.equal(dim('138'), 138);
  assert.equal(dimsOf({ L: 138, W: '', H: 108 }), null);
  assert.deepEqual(dimsOf({ L: '138', W: 75, H: 108 }), { L: 138, W: 75, H: 108 });
  assert.equal(sizeText({ L: 138, W: 75, H: 108 }), '138X75X108');
  assert.equal(sizeText({ L: 102.5, W: 15, H: 75 }), '102.5X15X75');
  assert.deepEqual(parseSizeText('138X75X108'), { L: 138, W: 75, H: 108 });
  assert.deepEqual(parseSizeText('140x78x108'), { L: 140, W: 78, H: 108 });
  assert.deepEqual(parseSizeText(' 170 x 150 x 110 mm'), { L: 170, W: 150, H: 110 });
  // The product master writes the unit both ways (FP-371 is "130X115X130MM").
  assert.deepEqual(parseSizeText('130X115X130MM'), { L: 130, W: 115, H: 130 });
  assert.deepEqual(parseSizeText('278X140X62 MM'), { L: 278, W: 140, H: 62 });
  assert.equal(parseSizeText('A4'), null);
  assert.equal(parseSizeText(''), null);
  // The same carton turned another way is the same carton.
  assert.ok(sameCarton({ L: 78, W: 123, H: 24 }, { L: 124, W: 25, H: 80 }) === false);
  assert.ok(sameCarton({ L: 75, W: 138, H: 108 }, { L: 138, W: 75, H: 108 }));
});

test('the de-duplication key is the Fluence master\'s own', () => {
  for (const n of ['F1-O2', 'F-TRICHO GOLD', 'M9O2+', 'f cutizen', 'Dr. Fact 2'])
    assert.equal(nameKey(n), fluenceNameKey(n));
});

test('ids: the studio\'s own shapes pass, anything else is refused', () => {
  for (const id of ['k001', 'p150', 'f314', 'i150', 'n1a2b3c', 'dmugkv3nt', 'main']) assert.ok(validId(id), id);
  for (const id of ['', '../x', 'a b', 'x'.repeat(65), null, 12]) assert.ok(!validId(id), String(id));
});

test('a status the studio does not know is MISSING, never a guess', () => {
  assert.equal(statusOf('CONFIRMED'), 'CONFIRMED');
  assert.equal(statusOf('confirmed'), 'MISSING');
  assert.equal(statusOf(undefined), 'MISSING');
});

test('splitKit: promoted columns, ERP facts dropped, the rest kept in data', () => {
  const { errors, row, items } = splitKit({
    name: ' F1-O2 ', family: 'Hair Fact', L: '138', W: 75, H: 108, sizeStatus: 'CONFIRMED', sizeSource: 'print files',
    code: 20251013, party: 1, erp: { kitId: 314 }, updatedAt: 'x', updatedBy: 'y',
    items: [{ pid: 'p108', q: 1, mrp: 109 }, { pid: 'p105', q: '2', mrp: '' }, { pid: null, raw: 'typed' }],
    layout: { rows: [] }, remarks: 'r', history: [{ at: 't', by: 'Anik', what: 'size' }], origin: 'master', status: 'Active',
  });
  assert.deepEqual(errors, []);
  assert.equal(row.name, 'F1-O2');
  assert.deepEqual([row.carton_l, row.carton_w, row.carton_h, row.size_status], [138, 75, 108, 'CONFIRMED']);
  assert.deepEqual(items, [{ pid: 'p108', q: 1, mrp: 109 }, { pid: 'p105', q: 2, mrp: null }]);
  for (const k of ['name', 'family', 'L', 'W', 'H', 'sizeStatus', 'sizeSource', 'party', 'erp', 'updatedAt', 'updatedBy'])
    assert.ok(!(k in row.data), `${k} must not be stored in data`);
  // The studio's own code stays as the fallback for a kit with no linked product.
  assert.equal(row.data.code, 20251013);
  assert.deepEqual(row.data.layout, { rows: [] });
  assert.equal(row.data.history.length, 1);
  assert.deepEqual(row.data.items, items);
});

test('splitKit refuses what the Fluence master would refuse', () => {
  assert.match(splitKit({ name: '' }).errors.join(' '), /needs a name/);
  assert.match(splitKit({ name: 'K', items: [{ pid: 'p1', q: 1 }, { pid: 'p1', q: 2 }] }).errors.join(' '), /listed twice/);
  assert.match(splitKit({ name: 'K', items: [{ pid: 'p1', q: 0 }] }).errors.join(' '), /more than zero/);
  assert.match(splitKit({ name: 'K', L: 'abc' }).errors.join(' '), /carton L/);
  assert.match(splitKit({ name: 'K', items: [{ pid: 'p1', q: 1, mrp: -5 }] }).errors.join(' '), /MRP/);
});

test('splitProduct: the MRP travels, sizes are columns', () => {
  const { errors, row, mrp, dims } = splitProduct({ name: 'F-CUTIZEN', mrp: '', L: 102, W: 15, H: 75, sizeStatus: 'CONFIRMED', remarks: 'x', ref: null });
  assert.deepEqual(errors, []);
  assert.equal(mrp, null);
  assert.deepEqual(dims, { L: 102, W: 15, H: 75 });
  assert.equal(row.data.remarks, 'x');
  assert.ok(!('L' in row.data) && !('sizeStatus' in row.data));
  assert.match(splitProduct({ name: 'X', mrp: 'free' }).errors.join(' '), /MRP/);
});

test('the Fluence master only ever holds a CONFIRMED size', () => {
  assert.deepEqual(masterDimsFor({ carton_l: 102, carton_w: 15, carton_h: 75, size_status: 'CONFIRMED' }), { L: 102, W: 15, H: 75 });
  assert.equal(masterDimsFor({ carton_l: 102, carton_w: 15, carton_h: 75, size_status: 'VERIFY' }), null);
  assert.equal(masterDimsFor({ carton_l: 102, carton_w: null, carton_h: 75, size_status: 'CONFIRMED' }), null);
});

test('splitSettings: clearances are millimetres', () => {
  assert.deepEqual(splitSettings({ cL: '4', note: 'n', updatedAt: 'x' }).data, { cL: 4, note: 'n' });
  assert.match(splitSettings({ cL: -1 }).errors.join(' '), /cL/);
});

const FK = {
  id: 314, kit_name: 'F1-O2', source_ref: 'customer-master:party-sl:1', party_sl_no: 1, product_id: 1280,
  superseded_by_kit_id: null, product_code: 'FP-013', product_name: 'F1O2', party_item_code: '20251013', product_size: '138X75X108',
};
const COMPS = [{ inner_product_id: 257, qty_per_kit: '1', mrp_in_kit: '109' }, { inner_product_id: 999, qty_per_kit: '2', mrp_in_kit: null }];
const pidOf = id => ({ 257: 'p108' }[id] || `i${id}`);

test('kitDoc: what is in the kit, its code and party come from the Fluence master', () => {
  const row = {
    id: 'k001', name: 'renamed in studio', family: 'Hair Fact', carton_l: '138', carton_w: '75', carton_h: '108',
    size_status: 'CONFIRMED', size_source: 'print files', version: 3, updated_at: '2026-09-26T08:00:00Z', updated_by: 'Anik',
    data: { items: [{ pid: 'stale', q: 9 }], code: 111, remarks: 'r', layout: { a: 1 }, history: [] },
  };
  const d = kitDoc(row, FK, COMPS, pidOf);
  assert.equal(d.name, 'F1-O2', 'a master kit keeps the customer\'s name');
  assert.equal(d.code, 20251013);
  assert.equal(d.party, 1);
  assert.deepEqual(d.items, [{ pid: 'p108', q: 1, mrp: 109 }, { pid: 'i999', q: 2, mrp: null }]);
  assert.deepEqual([d.L, d.W, d.H, d.sizeStatus], [138, 75, 108, 'CONFIRMED']);
  assert.equal(d.erp.productCode, 'FP-013');
  assert.equal(d.erp.own, false);
  assert.equal(d.remarks, 'r');
  assert.deepEqual(d.layout, { a: 1 });
  assert.equal(d.updatedBy, 'Anik');
});

test('kitDoc: a kit the studio created keeps its own name and code until a product answers', () => {
  const own = { ...FK, source_ref: 'kit-studio:n1', product_id: null, party_item_code: null, product_code: null, product_name: null, product_size: null };
  const d = kitDoc({ id: 'n1', name: 'New kit', data: { code: 20259999 }, size_status: 'PROPOSED' }, own, [], pidOf);
  assert.equal(d.name, 'New kit');
  assert.equal(d.code, 20259999);
  assert.equal(d.erp.own, true);
  assert.equal(d.erp.productId, null);
});

test('kitDoc: a Fluence kit never saved in the studio starts from the ERP product size, to verify', () => {
  const d = kitDoc(null, FK, COMPS, pidOf);
  assert.deepEqual([d.L, d.W, d.H, d.sizeStatus, d.sizeSource], [138, 75, 108, 'VERIFY', 'ERP product size']);
  const none = kitDoc(null, { ...FK, product_size: 'see drawing' }, [], pidOf);
  assert.deepEqual([none.L, none.sizeStatus], [null, 'MISSING']);
});

test('productDoc: name, MRP and a confirmed size come from the master', () => {
  const inner = { id: 168, name: 'F-COLLASURGE (1X4)', kind: 'item', standard_mrp: '564', carton_l: '124', carton_w: '25', carton_h: '80', active: 1, source: 'customer-master-2026-08-22' };
  const row = { id: 'p018', name: 'old', carton_l: 78, carton_w: 123, carton_h: 24, size_status: 'VERIFY', data: { mrp: 1, remarks: 'r' } };
  const d = productDoc(row, inner);
  assert.equal(d.name, 'F-COLLASURGE (1X4)');
  assert.equal(d.mrp, 564);
  assert.deepEqual([d.L, d.W, d.H, d.sizeStatus, d.sizeSource], [124, 25, 80, 'CONFIRMED', 'Fluence Master']);
  // Confirmed here, cleared in the master since: not confirmed any more.
  const cleared = productDoc({ ...row, carton_l: 124, carton_w: 25, carton_h: 80, size_status: 'CONFIRMED' },
    { ...inner, carton_l: null, carton_w: null, carton_h: null });
  assert.equal(cleared.sizeStatus, 'VERIFY');
  // An inner product the studio has never saved.
  const fresh = productDoc(null, { ...inner, carton_l: null, carton_w: null, carton_h: null, active: 0 });
  assert.deepEqual([fresh.sizeStatus, fresh.status], ['MISSING', 'Inactive']);
});

// ── Wiring: additive, replayed locally, announced on the realtime feed ───────

test('the Kit Studio migration only adds', () => {
  const sql = read(MIGRATION).replace(/--[^\n]*/g, '');
  assert.doesNotMatch(sql, /\bdrop\s+(table|column|constraint|index|schema)\b/i);
  assert.doesNotMatch(sql, /\balter\s+table\b/i);
  assert.doesNotMatch(sql, /\bupdate\s+\w+\s+set\b|\bdelete\s+from\b|\btruncate\s+(table\s+)?(?!on\b)\w/i);
  const created = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map(m => m[1]);
  assert.deepEqual(created, ['kit_studio_kits', 'kit_studio_products', 'kit_studio_drafts', 'kit_studio_settings']);
  for (const fk of sql.matchAll(/REFERENCES (\w+)\(id\) ON DELETE (\w+ \w+)/g))
    assert.equal(fk[2], 'SET NULL', `${fk[1]} link must be ON DELETE SET NULL`);
});

test('every Kit Studio table announces its changes, guarded for local databases', () => {
  const sql = read(MIGRATION);
  assert.match(sql, /to_regprocedure\('public\.ci_erp_realtime_ping\(\)'\) is null/);
  for (const t of ['kit_studio_kits', 'kit_studio_products', 'kit_studio_drafts', 'kit_studio_settings'])
    assert.match(sql, new RegExp(`'${t}'`), `${t} is not bound to the realtime ping`);
  assert.match(sql, /after insert or update or delete/);
  assert.match(sql, /after truncate/);
});

test('init() replays the migration after the Fluence master it builds on', () => {
  const db = read('server/src/db.js');
  const fluence = db.indexOf("migration('20260917120000_fluence_prescription_kits.sql')");
  const studio = db.indexOf("migration('20260926100000_kit_studio.sql')");
  assert.ok(fluence > 0 && studio > fluence);
});

test('the studio route is mounted, and every write needs a Planning role', () => {
  const app = read('server/src/app.js');
  assert.match(app, /import kitStudio from '\.\/routes\/kitstudio\.js'/);
  assert.match(app, /app\.use\('\/api', kitStudio\)/);
  const route = read('server/src/routes/kitstudio.js');
  const writes = [...route.matchAll(/r\.(put|post|delete)\('([^']+)',\s*(\w+)?/g)];
  assert.ok(writes.length >= 9);
  // The product master itself is kept by planners and admins only — the same
  // rule as Masters (masters.js requireRole('planner')). Everything else in the
  // studio is open to every Planning role.
  const PRODUCT_MASTER = ['/kit-studio/kits/:id/erp-product', '/kit-studio/kits/:id/erp-link', '/kit-studio/kits/:id/erp-unlink'];
  for (const [, verb, path, guard] of writes) {
    assert.equal(guard, PRODUCT_MASTER.includes(path) ? 'canKeepProducts' : 'canEditStudio', `${verb.toUpperCase()} ${path} is not guarded`);
  }
  assert.deepEqual(writes.filter(w => w[3] === 'canKeepProducts').map(w => w[2]).sort(), [...PRODUCT_MASTER].sort());
  assert.match(route, /const canKeepProducts = requireRole\('planner'\);/);
  assert.match(read('server/src/routes/masters.js'), /const canEdit = requireRole\('planner'\);/, 'Masters changed who keeps products');
});

// ── The kit carton in the product master ────────────────────────────────────

test('billing codes: 8 digits in the Fluence series, the next one after the highest', () => {
  assert.equal(billingCodeOf(' 20251368 '), '20251368');
  for (const bad of ['2025136', '202513689', '202251024', '30251368', 'FP-373', '', null]) assert.equal(billingCodeOf(bad), null, String(bad));
  assert.equal(nextBillingCode(['20251367', '20251352', null, 'x', '20251001']), '20251368');
  assert.equal(nextBillingCode([]), null, 'nothing on record: nothing to follow, never a guess');
  assert.equal(nextBillingCode(['20259999']), '20260000');
});

test('productInput: a name for a new carton, a well-formed code, a positive MRP', () => {
  const ok = productInput({ name: '  dr. fact   shed control ', billing_code: '20251368', mrp: '950', ref_product_id: '1509' });
  assert.deepEqual(ok, { errors: [], name: 'dr. fact shed control', billingCode: '20251368', mrp: 950, refId: 1509 });
  assert.deepEqual(productInput({ name: 'X', billing_code: '', mrp: '' }).errors, []);
  assert.equal(productInput({ name: 'X', billing_code: '' }).billingCode, null, 'blank until Fluence issues one');
  assert.match(productInput({ name: 'X', billing_code: '202251024' }).errors.join(), /not a Fluence billing code/);
  assert.match(productInput({ name: 'X', mrp: 0 }).errors.join(), /more than zero/);
  assert.match(productInput({ name: 'X', mrp: '-5' }).errors.join(), /more than zero/);
  assert.match(productInput({}).errors.join(), /needs a name/);
  assert.deepEqual(productInput({}, { create: false }).errors, [], 'a link names no product');
  assert.match(productInput({ name: 'X', ref_product_id: 'abc' }).errors.join(), /print spec/);
});

test('a new carton copies the board and print always, the die and sheet only for the same size', () => {
  const ref = {
    customer_id: 43, board_material_id: 378, board_name: 'Met Saffire · 340 GSM · 20x38', board_grade: 'Met Saffire', gsm: 350, colors: 6,
    colour_type: 'CMYK + Pantone', print_process: 'Offset', cmyk_colours: 4, pantone_colours: 2, metallic_colours: null, coating: 'Drip Off',
    special: 'emboss', emboss: 1, leafing: 0, leafing_colour: null, pasting_type: 'LOCK BOTTOM', product_type: 'carton', wastage_pct: 8,
    die_number: 'D-118', tool_id: 7, ups: 2, child_l: 19, child_w: 20, parent_l: 20, parent_w: 38,
    // never copied: the artwork's own and the price
    party_item_code: '20251013', party_artwork_code: 'AW-1', shade_card_number: 'SC-1', block_number: 'B-1', rate: 84.15, mrp: 908,
  };
  const base = { customerId: 43, name: 'SHED CONTROL', code: 'FP-373', billingCode: '20251368', mrp: 950, size: '140X90X125', ref };
  const other = newProductRow({ ...base, sameSize: false });
  assert.equal(other.code, 'FP-373');
  assert.equal(other.internal_carton_code, 'FP-373', 'the FG-matching mirror of the code');
  assert.equal(other.party_item_code, '20251368');
  assert.equal(other.spec_incomplete, 1, 'Planning still has to check it');
  assert.equal(other.active, 1);
  assert.equal(other.board_material_id, 378);
  assert.equal(other.coating, 'Drip Off');
  for (const c of SPEC_SAME_CARTON) assert.ok(!(c in other), `${c} copied for a different size`);
  for (const c of ['party_artwork_code', 'shade_card_number', 'block_number', 'rate']) assert.ok(!(c in other), `${c} must never be copied`);
  assert.equal(other.mrp, 950, 'the MRP is the dialog\'s, never the model kit\'s');
  const same = newProductRow({ ...base, sameSize: true });
  for (const c of SPEC_SAME_CARTON) assert.equal(same[c], ref[c], c);
  const bare = newProductRow({ customerId: 43, name: 'X', code: 'FP-374', boardId: 999 });
  assert.equal(bare.board_material_id, 999, 'no spec to copy: the placeholder board');
  assert.equal(bare.party_item_code, null);
  assert.equal(bare.spec_incomplete, 1);
  assert.ok(SPEC_COPIED.every(c => !SPEC_SAME_CARTON.includes(c)));
});

test('a kit finds the product an order already brought in, before anyone makes a second one', () => {
  assert.equal(nameMatch('Shed Control', 'DR. FACT SHED CONTROL'), 0.9);
  assert.equal(nameMatch('Hydra boost', 'SKIN FACT HYDRA BOOST'), 0.9);
  assert.equal(nameMatch('F1-O2', 'F1O2'), 1);
  assert.ok(nameMatch('Hydra boost', 'DR.FACT VOLU-BOOST') < 0.5);
  assert.equal(nameMatch('Shed Control', 'SKINFACT OPEN PORES'), 0);
  const free = [
    { id: 1712, code: 'FP-372', name: 'SKINFACT OPEN PORES', size: '156X78X108' },
    { id: 1711, code: 'FP-371', name: 'SKIN FACT HYDRA BOOST', size: '130X115X130MM' },
    { id: 1710, code: 'FP-370', name: 'DR.FACT VOLU-BOOST', size: '135X75X108' },
    { id: 1709, code: 'FP-369', name: 'DR. FACT SHED CONTROL', size: '138X90X108' },
  ];
  const shed = rankMatches({ name: 'Shed Control', dims: { L: 140, W: 90, H: 125 } }, free);
  assert.equal(shed[0].code, 'FP-369');
  assert.ok(shed[0].score >= 0.85);
  const hydra = rankMatches({ name: 'Hydra boost', dims: { L: 130, W: 115, H: 130 } }, free);
  assert.equal(hydra[0].code, 'FP-371');
  assert.ok(hydra[0].same_size, 'the same carton size, whatever the unit spelling');
  assert.equal(hydra[0].score, 1);
  // The same size alone makes nothing a match.
  assert.equal(rankMatches({ name: 'Brand New', dims: { L: 156, W: 78, H: 108 } }, free)[0].score, 0);
});

test('the product master routes: one transaction, the code minted and the billing code claimed inside it', () => {
  const route = read('server/src/routes/kitstudio.js');
  const block = (from, to) => { const a = route.indexOf(from); assert.ok(a >= 0, from); return route.slice(a, route.indexOf(to, a + from.length)); };
  const create = block("r.post('/kit-studio/kits/:id/erp-product'", "r.post('/kit-studio/kits/:id/erp-link'");
  assert.match(create, /await tx\(async \(qc, oc\) =>/);
  assert.match(create, /assertNoCarton\(k\)/);
  assert.match(create, /code = await nextProductCode\(customerId, qc, oc\)/);
  assert.match(create, /claimBillingCode\(/);
  assert.match(create, /linkKit\(k\.fk, product,/);
  assert.match(create, /productCodeTaken\(e, code, true\)/);
  // A same-name Fluence product is refused: link it instead of making a second.
  assert.match(create, /already in the product master — link this kit to it/);
  const link = block("r.post('/kit-studio/kits/:id/erp-link'", "r.post('/kit-studio/kits/:id/erp-unlink'");
  assert.match(link, /assertNoCarton\(k\)/);
  assert.match(link, /already carries the kit/);
  assert.match(link, /part carton/);
  // Only an EMPTY billing code or MRP is filled; one already on the product is never changed here.
  assert.match(link, /input\.billingCode && !String\(p\.party_item_code \?\? ''\)\.trim\(\)/);
  assert.match(link, /input\.mrp != null && p\.mrp == null/);
  // Every billing-code write queues on one lock BEFORE it checks who has the code.
  const claim = block('async function claimBillingCode', '\n}\n');
  assert.ok(claim.indexOf("lockDocNumber('fluence-billing-code', oc)") >= 0);
  assert.ok(claim.indexOf("lockDocNumber('fluence-billing-code', oc)") < claim.indexOf('billingCodeHolder('));
  // The unlink lets go of the studio's own kits only.
  const unlink = block("r.post('/kit-studio/kits/:id/erp-unlink'", '// ── Inner products');
  assert.match(unlink, /if \(!k\.own\) throw fail\(409/);
});

test('a double-clicked Create joins the first instead of minting a second FP- code', async () => {
  const { MINTING_POSTS, mintsNumber } = await import('../../client/src/lib/writeOnce.js');
  assert.ok(MINTING_POSTS.includes('/kit-studio/kits/:id/erp-product'));
  assert.ok(mintsNumber('/kit-studio/kits/n1a2b3c/erp-product'));
  assert.ok(!mintsNumber('/kit-studio/kits/n1a2b3c/erp-link'), 'a link mints nothing');
});

test('a customer kit linked over a studio kit takes its studio entry along', () => {
  const route = read('server/src/routes/fluence.js');
  const a = route.indexOf("String(holder.source_ref).startsWith('kit-studio:')");
  const b = route.indexOf("DELETE FROM fluence_kits WHERE id = $1', [holder.id]");
  assert.ok(a > 0 && b > a, 'the studio row must be re-pointed before the holder kit is deleted');
  assert.match(route.slice(a, b), /UPDATE kit_studio_kits SET fluence_kit_id = \$1 WHERE fluence_kit_id = \$2/);
});

test('the studio page is served from our own origin, bridge first, no CDN', () => {
  const html = read('client/public/kit-studio-app/index.html');
  assert.match(html, /^<!doctype html>/);
  assert.ok(html.indexOf('<script src="erp-bridge.js"></script>') < html.indexOf('<script>\n'), 'the bridge must load before the studio');
  assert.doesNotMatch(html, /cdnjs\.cloudflare\.com/);
  // It wears the ERP's own theme: system fonts, light only, on the ERP's canvas.
  assert.doesNotMatch(html, /IBM Plex|Archivo/);
  const fonts = html.match(/https:\/\/fonts\.googleapis\.com\/css2\?[^"]+/g) || [];
  assert.equal(fonts.length, 1, 'one font sheet: the ERP\'s own');
  assert.ok(read('client/index.html').includes(fonts[0]), 'the studio loads the same typeface as the ERP');
  assert.doesNotMatch(html, /prefers-color-scheme:\s*dark|data-theme="dark"/);
  assert.match(html, /html,body\{background:transparent\}/);
  assert.match(html, /const PDF_LIB=\['lib\/jspdf\.umd\.min\.js','lib\/jspdf\.plugin\.autotable\.min\.js'\]/);
  for (const f of ['erp-bridge.js', 'lib/jspdf.umd.min.js', 'lib/jspdf.plugin.autotable.min.js'])
    assert.ok(read(`client/public/kit-studio-app/${f}`).length > 1000, `${f} missing`);
  const bridge = read('client/public/kit-studio-app/erp-bridge.js');
  assert.match(bridge, /window\.parent\.__kitStudioHost/);
  assert.doesNotMatch(bridge, /ci_token|localStorage/, 'the studio never touches the ERP sign-in');
});

// Vercel answers from the filesystem BEFORE any rewrite, and a folder's
// index.html answers the folder's own path. The static page first shipped at
// /kit-studio/ — the module's own route — so a refresh on motionci.in/kit-studio
// served the bare studio page instead of the ERP around it (2026-09-26). No
// folder in client/public may carry the name of an app route.
test('no static folder shadows an app route', async () => {
  const { readdirSync, statSync } = await import('node:fs');
  const { MODULES } = await import('../../client/src/modules.js');
  const pub = new URL('client/public/', root);
  const dirs = readdirSync(pub).filter(n => statSync(new URL(n, pub)).isDirectory());
  const routes = MODULES.flatMap(m => [m.path, ...(m.aliases || [])]).map(p => p.split('/')[1]).filter(Boolean);
  for (const d of dirs) assert.ok(!routes.includes(d), `client/public/${d}/ would answer the /${d} route with its own index.html`);
  assert.ok(dirs.includes('kit-studio-app'));
  assert.match(read('client/src/pages/KitStudio.jsx'), /src="\/kit-studio-app\/index\.html"/);
});

test('Kit Studio is a module anyone with Fluence access can open', async () => {
  const { MODULES, canAccess, moduleForPath } = await import('../../client/src/modules.js');
  assert.equal(MODULES.at(-1).key, 'kit_studio', 'last, so no login\'s first module changes');
  assert.equal(moduleForPath('/kit-studio'), 'kit_studio');
  assert.ok(canAccess({ role: 'viewer', modules: ['fluence'] }, 'kit_studio'));
  assert.ok(canAccess({ role: 'viewer', modules: ['kit_studio'] }, 'kit_studio'));
  assert.ok(!canAccess({ role: 'viewer', modules: ['orders'] }, 'kit_studio'));
  assert.ok(canAccess({ role: 'planner', modules: null }, 'kit_studio'));
});

// What is in a kit and how each item is taken are edited in ONE place — the
// one-table editor (KitRxEditor) in the Fluence drawer — and saved together.
// The studio sizes and arranges a kit; it hands the contents over.
test('an existing kit\'s contents are edited with its prescription, not in the studio', () => {
  const html = read('client/public/kit-studio-app/index.html');
  // The drawer of a kit in the Fluence master reads its contents and hands over.
  assert.match(html, /d\.erp&&d\.erp\.kitId\?kitContentsCard\(d,ro\):/);
  assert.match(html, /X\.openKitEditor\(D\.d\.erp\.kitId,\{edit:S\.canEdit\}\)/);
  // Removing a carton would take an item out: not on such a kit.
  const rm = html.slice(html.indexOf('function removeSel(ctx){'), html.indexOf('function swapCols('));
  assert.match(rm, /^function removeSel\(ctx\)\{\n\s+if\(contentsLocked\(ctx\)\)\{ toast\(/);
  assert.match(html, /contentsLocked\(ctx\)\?'':b\('del'/);
  // An open kit takes the master's new contents when they change under it.
  assert.match(html, /render\(\); resolveNames\(\); syncDrawerContents\(\); \}/);
  // The bridge offers the hand-off only when the host can do it; the host opens the drawer.
  const bridge = read('client/public/kit-studio-app/erp-bridge.js');
  assert.match(bridge, /openKitEditor: typeof host\.openKitEditor === 'function'/);
  const hostPage = read('client/src/pages/KitStudio.jsx');
  assert.match(hostPage, /openKitEditor\(kitId, opts = \{\}\)/);
  assert.match(hostPage, /<FluenceDrawer key=\{kitEditor\.kitId\} kitId=\{kitEditor\.kitId\} startEditing=\{kitEditor\.edit\} context="kit_studio"/);
  // The server agrees: a studio save may not change an existing kit's contents.
  const route = read('server/src/routes/kitstudio.js');
  assert.match(route, /if \(created\) \{[\s\S]*?await keepRxInStep\(fk\.id, req\.user, FROM, qc, oc\);\s*\} else \{\s*await assertSameContents\(fk\.id, items, qc\);\s*\}/);
});

test('the one-table editor saves contents and prescription in one request, naming what it opened', () => {
  const editor = read('client/src/components/fluence/KitRxEditor.jsx');
  assert.match(editor, /dossier\.product \? `\/fluence\/products\/\$\{dossier\.product\.id\}\/kit` : `\/fluence\/kits\/\$\{dossier\.kit\.id\}\/kit`/);
  assert.match(editor, /base_components: componentsSignature\(dossier\.components \|\| \[\]\)/);
  assert.match(editor, /base_revision: dossier\.prescription\?\.revision \?\? 0/);
  const route = read('server/src/routes/fluence.js');
  for (const path of ["r.put('/fluence/products/:productId/kit', canEditMaster", "r.put('/fluence/kits/:id/kit', canEditMaster", "r.get('/fluence/kits/:id/dossier'"])
    assert.ok(route.includes(path), path);
  // Both halves in one transaction, each with its own revision only when it changed.
  const save = route.slice(route.indexOf('async function saveKitAndRx'), route.indexOf("r.put('/fluence/products/:productId/kit'"));
  assert.match(save, /componentsSignature\(beforeComps\) !== componentsSignature\(components\)/);
  assert.match(save, /!\(beforeRx && sameRx\(beforeRx, value\)\)/);
  assert.match(save, /throw fail\(409, 'The kit list was changed by someone else/);
  // The old kit-list route keeps the prescription in step with what it wrote.
  const comps = route.slice(route.indexOf("r.put('/fluence/products/:productId/components'"), route.indexOf('// ── Inner product master'));
  assert.match(comps, /await keepRxInStep\(kit\.id, req\.user, from, qc, oc\);/);
});

test('Masters and the Fluence drawer point at each other', () => {
  const masters = read('client/src/pages/Masters.jsx');
  assert.match(masters, /<FluenceButton productId=\{r\.id\} context="masters" compact/);
  assert.match(masters, /<FluenceButton productId=\{editing\.id\} context="masters" label="Fluence kit & prescription" \/>/);
  assert.match(masters, /new URLSearchParams\(location\.search\)\.get\('edit'\)/);
  const drawer = read('client/src/components/fluence/FluenceDrawer.jsx');
  assert.match(drawer, /`\/masters\?tab=products&edit=\$\{dossier\.product\.id\}`/);
  assert.match(drawer, /context !== 'masters' && canAccess\(user, 'masters'\)/);
});
