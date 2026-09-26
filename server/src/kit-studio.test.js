// Kit Studio inside the ERP: how a studio document maps onto kit_studio_* rows
// and the Fluence master (kit-studio.js), and the wiring that keeps it additive.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  dim, dimsOf, sizeText, parseSizeText, sameCarton, statusOf, masterDimsFor, validId, nameKey,
  splitKit, splitProduct, splitSettings, kitDoc, productDoc,
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
  assert.ok(writes.length >= 6);
  for (const [, verb, path, guard] of writes) assert.equal(guard, 'canEditStudio', `${verb.toUpperCase()} ${path} is not guarded`);
});

test('the studio page is served from our own origin, bridge first, no CDN', () => {
  const html = read('client/public/kit-studio/index.html');
  assert.match(html, /^<!doctype html>/);
  assert.ok(html.indexOf('<script src="erp-bridge.js"></script>') < html.indexOf('<script>\n'), 'the bridge must load before the studio');
  assert.doesNotMatch(html, /cdnjs\.cloudflare\.com/);
  assert.match(html, /const PDF_LIB=\['lib\/jspdf\.umd\.min\.js','lib\/jspdf\.plugin\.autotable\.min\.js'\]/);
  for (const f of ['erp-bridge.js', 'lib/jspdf.umd.min.js', 'lib/jspdf.plugin.autotable.min.js'])
    assert.ok(read(`client/public/kit-studio/${f}`).length > 1000, `${f} missing`);
  // Vercel serves a file that exists before any rewrite; the SPA catch-all must
  // not be what answers /kit-studio/.
  const bridge = read('client/public/kit-studio/erp-bridge.js');
  assert.match(bridge, /window\.parent\.__kitStudioHost/);
  assert.doesNotMatch(bridge, /ci_token|localStorage/, 'the studio never touches the ERP sign-in');
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
