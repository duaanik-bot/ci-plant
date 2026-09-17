// GET /products/identity — the product master as identity.
//
// Nearly every screen renders a product name, and a name that arrives without
// its codes sends ProductIdentity to its one app-wide cache of the master. That
// cache was pulling all 54 columns of all 1,649 products — 1,854 KB — to print
// three code chips and to have something for the history panel to open with.
//
// The identity list carries exactly what those two render. This test pins the
// column list against both readers, because a missing column here is a blank
// chip or a missing line in the history panel on every screen at once.
//
// Then the list itself went: a station queue names tens of products, never
// 1,656, yet every page load still parsed ~1,062 KB on the tablet to find them.
// The client now asks for the ids it is actually missing (?ids=1,2,3). The bare
// route stays exactly as it was — plant tablets run an old bundle for days and
// that bundle still asks for the whole list.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const identity = await import('./product-identity.js').catch(() => null);
const batch = await import('../../client/src/lib/idBatchLoader.js').catch(() => null);

const masters = readFileSync(new URL('./routes/masters.js', import.meta.url), 'utf8');
const sql = identity?.productIdentitySql?.()
  ?? masters.split("r.get('/products/identity'")[1]?.split('});')[0] ?? '';

// The SELECT the route ran before ?ids existed, byte for byte. The no-param
// response is this query's rows handed to res.json untouched, so pinning the
// query text and the pass-through pins the response an old bundle receives.
const BASE_SQL = '\n      SELECT p.id, p.name, p.code, p.internal_carton_code, p.party_item_code, p.party_artwork_code,\n             p.output_number, p.shade_card_number, p.board_grade, p.gsm, p.size,\n             p.child_l, p.child_w, p.parent_l, p.parent_w, p.ups,\n             p.colors, p.colour_type, p.print_process, p.coating, p.special, p.pasting_type,\n             p.emboss, p.leafing, p.leafing_colour, p.die_number, p.block_number,\n             p.product_type, p.rate, p.mrp,\n             m.name AS board_material_name,\n             COALESCE(p.gst_pct, gr.rate, 12) AS effective_gst\n      FROM products p\n      JOIN materials m ON m.id = p.board_material_id\n      LEFT JOIN gst_rates gr ON gr.product_type = p.product_type\n      ORDER BY p.name';

// ProductIdentity.jsx: the map key, the name, and the three code chips
// (productCodeParts → internal / artwork / party).
const IDENTITY = ['id', 'name', 'code', 'internal_carton_code',
  'party_item_code', 'party_artwork_code'];

// MasterHistory.jsx → ProductBrief: every line it prints for kind="products".
const PRODUCT_BRIEF = ['output_number', 'shade_card_number', 'board_material_name',
  'board_grade', 'gsm', 'size', 'child_l', 'child_w', 'parent_l', 'parent_w', 'ups',
  'colors', 'colour_type', 'print_process', 'coating', 'special', 'pasting_type',
  'emboss', 'leafing', 'leafing_colour', 'die_number', 'block_number', 'product_type',
  'effective_gst', 'rate', 'mrp'];

test('the identity route exists and selects every code a chip prints', () => {
  assert.ok(sql.includes('FROM products p'), 'GET /products/identity must be registered');
  for (const f of IDENTITY) {
    assert.match(sql, new RegExp(`\\b${f}\\b`), `identity chip reads ${f}`);
  }
});

test('it also selects every line the product history panel prints', () => {
  const missing = PRODUCT_BRIEF.filter(f => !new RegExp(`\\b${f}\\b`).test(sql));
  assert.deepEqual(missing, [], `ProductBrief renders these: ${missing.join(', ')}`);
});

// ── The server: ?ids is opt-in, the bare route is untouched ────────────────

// Drive the route handler with a recording q() and a fake res — no database.
async function call(query, rows = [{ id: 1, name: 'A' }]) {
  assert.ok(identity?.productIdentityRoute, 'product-identity.js must export productIdentityRoute(q)');
  const calls = [];
  const q = async (text, params) => { calls.push({ text, params }); return rows; };
  const out = { json: undefined, error: undefined };
  const res = { json: body => { out.json = body; return res; } };
  await identity.productIdentityRoute(q)({ query }, res, e => { out.error = e; });
  return { calls, ...out };
}

test('masters.js serves /products/identity through the shared handler', () => {
  assert.match(masters, /r\.get\('\/products\/identity',\s*productIdentityRoute\(q\)\)/,
    'the route must be the tested handler, not a second copy of the query');
});

test('no ids: the same query, its rows passed through untouched (old bundles)', async () => {
  const rows = [{ id: 2, name: 'B' }, { id: 1, name: 'A' }];
  const { calls, json, error } = await call({}, rows);
  assert.equal(error, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, BASE_SQL, 'the bare route must run the pre-?ids SELECT byte for byte');
  assert.equal(calls[0].params, undefined);
  assert.equal(json, rows, 'the rows must reach res.json as the query returned them');
});

test('?ids: same columns and order, narrowed to those ids, deduped integers only', async () => {
  const { calls, json, error } = await call({ ids: '3,1,3, abc,-2,0,2.5,7,1e3,0012' });
  assert.equal(error, undefined);
  assert.equal(calls.length, 1);
  const { text, params } = calls[0];
  assert.match(text, /WHERE p\.id = ANY\(\$1::int\[\]\)\n\s*ORDER BY p\.name$/,
    'the id filter sits just before the unchanged ORDER BY');
  assert.equal(text.replace(/\n\s*WHERE p\.id = ANY\(\$1::int\[\]\)/, ''), BASE_SQL,
    'apart from the WHERE, the ?ids query must be the identity SELECT exactly');
  assert.deepEqual(params, [[3, 1, 7, 12]]);
  assert.ok(Array.isArray(json));
});

test('?ids repeated (ids=1&ids=2) reads as one list', async () => {
  const { calls } = await call({ ids: ['1', '2,1'] });
  assert.deepEqual(calls[0].params, [[1, 2]]);
});

test('?ids with nothing usable answers [] without touching the database', async () => {
  for (const ids of ['', 'abc', ',,', '-1']) {
    const { calls, json, error } = await call({ ids });
    assert.equal(error, undefined);
    assert.equal(calls.length, 0, `ids=${JSON.stringify(ids)} must not query`);
    assert.deepEqual(json, []);
  }
});

test('?ids is capped per request — a runaway caller is refused, not served the master', async () => {
  assert.equal(identity?.IDENTITY_IDS_CAP, 200);
  const atCap = Array.from({ length: 200 }, (_, i) => i + 1).join(',');
  assert.equal((await call({ ids: atCap })).calls.length, 1, '200 ids is allowed');
  const over = Array.from({ length: 201 }, (_, i) => i + 1).join(',');
  const { calls, error } = await call({ ids: over });
  assert.equal(calls.length, 0);
  assert.equal(error?.status, 400);
});

// ── The client: batched, capped, deduped, negatives remembered ─────────────

test('ProductIdentity asks for the ids it is missing, never the whole list', () => {
  const client = readFileSync(
    new URL('../../client/src/components/ProductIdentity.jsx', import.meta.url), 'utf8');
  assert.ok(client.includes('/products/identity?ids='),
    'the cache must ask /products/identity for the ids a row is missing');
  assert.equal(client.includes("api.get('/products/identity')"), false,
    'the 1,062 KB identity list must not be fetched whole any more');
  assert.equal(client.includes("api.get('/products')"), false,
    'the 1.8 MB master must not come back by the side door');
  assert.match(client, /createIdBatchLoader\(/, 'lookups go through the batching loader');
});

// A scheduler the test flushes by hand, standing in for one macrotask.
function manualLoader(fetchBatch, cap) {
  assert.ok(batch?.createIdBatchLoader, 'client/src/lib/idBatchLoader.js must export createIdBatchLoader');
  const tasks = [];
  const loader = batch.createIdBatchLoader({ fetchBatch, cap, schedule: fn => tasks.push(fn) });
  const flush = async () => {
    while (tasks.length) tasks.shift()();
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  return { loader, flush, tasks };
}

test('every lookup in one macrotask becomes ONE request, ids deduped', async () => {
  const seen = [];
  const { loader, flush } = manualLoader(async ids => {
    seen.push(ids);
    return ids.filter(id => id !== 9).map(id => ({ id, name: `P${id}` }));
  });
  const got = [loader.load(5), loader.load('5'), loader.load(6), loader.load(9)];
  await flush();
  assert.deepEqual(seen, [[5, 6, 9]]);
  assert.deepEqual(await Promise.all(got), [
    { id: 5, name: 'P5' }, { id: 5, name: 'P5' }, { id: 6, name: 'P6' }, null,
  ]);
});

test('a batch larger than the cap is split into capped requests', async () => {
  const sizes = [];
  const { loader, flush } = manualLoader(async ids => { sizes.push(ids.length); return []; }, 200);
  const all = Array.from({ length: 450 }, (_, i) => loader.load(i + 1));
  await flush();
  await Promise.all(all);
  assert.deepEqual(sizes, [200, 200, 50]);
});

test('found and NOT found are both remembered — no refetch on the next render', async () => {
  let fetches = 0;
  const { loader, flush } = manualLoader(async ids => { fetches++; return ids.includes(1) ? [{ id: 1 }] : []; });
  const a = [loader.load(1), loader.load(404)];
  await flush();
  assert.deepEqual(await Promise.all(a), [{ id: 1 }, null]);
  const b = [loader.load(1), loader.load(404)];
  await flush();
  assert.deepEqual(await Promise.all(b), [{ id: 1 }, null]);
  assert.equal(fetches, 1, 'a deleted or board-less product must not be asked for again');
});

test('an id already in flight is not requested twice', async () => {
  const seen = [];
  let release;
  const { loader, flush } = manualLoader(ids => { seen.push(ids); return new Promise(r => { release = () => r([{ id: 3 }]); }); });
  const first = loader.load(3);
  await flush();
  const second = loader.load(3);
  await flush();
  release();
  assert.deepEqual(await Promise.all([first, second]), [{ id: 3 }, { id: 3 }]);
  assert.deepEqual(seen, [[3]]);
});

test('a failed request is not remembered as "no such product"', async () => {
  let fail = true;
  let fetches = 0;
  const { loader, flush } = manualLoader(async () => { fetches++; if (fail) throw new Error('offline'); return [{ id: 8 }]; });
  const first = loader.load(8);
  await flush();
  assert.equal(await first, null);
  fail = false;
  const second = loader.load(8);
  await flush();
  assert.deepEqual(await second, { id: 8 });
  assert.equal(fetches, 2);
});

test('an id that is not a positive integer resolves null without a request', async () => {
  let fetches = 0;
  const { loader, flush, tasks } = manualLoader(async () => { fetches++; return []; });
  const got = [loader.load(null), loader.load('abc'), loader.load(0), loader.load(2.5)];
  assert.equal(tasks.length, 0, 'nothing to schedule');
  await flush();
  assert.deepEqual(await Promise.all(got), [null, null, null, null]);
  assert.equal(fetches, 0);
});
