import test from 'node:test';
import assert from 'node:assert/strict';
import { readinessBatch, effectiveProduct, fgMatchPredicate } from './helpers.js';

// readinessBatch in two waves, not five. Every statement it runs was keyed by ids
// known on entry (products, plate counts, board mix) or after them (the seven
// material / tool / shade / FG / allocation lookups) — so two round trips do.
// On production that is ~11 ms a round trip saved per wave once the pool can
// overlap them (docs/perf/2026-11-20-pool-size.md).
//
// The ctx must be IDENTICAL to the sequential version, kept below verbatim from
// main@57653fd4 as the reference.

const KEYS = [
  ['products', /FROM products WHERE id = ANY/],
  ['plates', /JOIN plate_request_components prc/],
  ['mix', /FROM job_board_mix/],
  ['materials', /FROM materials WHERE id = ANY/],
  ['batches', /FROM stock_batches/],
  ['tools', /FROM tools WHERE/],
  ['shades', /FROM shade_cards/],
  ['incoming', /FROM requisitions/],
  ['fg', /fg_lots/],
  ['holds', /FROM board_allocations/],
];
const keyOf = sql => (KEYS.find(([, re]) => re.test(sql)) || ['?'])[0];

// Two lines; line 2's board mix names material 77, which is neither product's board.
const FIX = {
  products: [{ id: 10, board_material_id: 5, tool_id: null }, { id: 11, board_material_id: 6, tool_id: 3 }],
  plates: [{ order_line_id: 1, required: 4, ready: 2 }],
  mix: [{ id: 1, order_line_id: 2, material_id: 77, role: 'planned', phase: 'plan' }],
  materials: [{ id: 5, name: 'A' }, { id: 6, name: 'B' }, { id: 77, name: 'Sub' }],
  batches: [{ material_id: 5, q: 100 }, { material_id: 77, q: 30 }],
  tools: [{ id: 3, product_id: null }, { id: 9, product_id: 10 }],
  shades: [{ product_id: 10, sc_number: 'SC-1', status: 'approved' }],
  incoming: [{ material_id: 5, qty: 4 }, { material_id: 6, qty: 0 }, { material_id: 77, qty: 0 }],
  fg: [{ product_id: 10, qty: 2 }, { product_id: 11, qty: 0 }],
  holds: [{ material_id: 77, order_line_id: 2, qty: 1, source: 'stock', gang_run_id: null },
          { material_id: 5, order_line_id: 1, qty: 3, source: 'pr', gang_run_id: null }],
};
const LINES = [{ id: 1, product_id: 10 }, { id: 2, product_id: 11 }];

// A fake qc: resolves on the next turn, remembers which statements had STARTED by
// the time each one resolved, and the params each got.
function fakeDb({ fail } = {}) {
  const started = [];
  const seenAtResolve = {};
  const params = {};
  const qc = (sql, p) => {
    const key = keyOf(sql);
    started.push(key);
    params[key] = p;
    return new Promise((resolve, reject) => setImmediate(() => {
      seenAtResolve[key] = [...started];
      if (key === fail) reject(new Error(`boom: ${key}`)); else resolve(FIX[key] || []);
    }));
  };
  return { qc, started, seenAtResolve, params };
}
// One statement at a time, in order — a transaction's single client.
function serialDb() {
  const db = fakeDb();
  let chain = Promise.resolve();
  const qc = (sql, p) => { const run = chain.then(() => db.qc(sql, p)); chain = run.catch(() => {}); return run; };
  return { ...db, qc };
}
const asPlain = ctx => Object.fromEntries(Object.entries(ctx).map(([k, v]) => [k, [...v]]));

test('products, plate counts and the board mix start together', async () => {
  const db = fakeDb();
  await readinessBatch(LINES, undefined, db.qc);
  for (const key of ['plates', 'mix']) {
    assert.ok(db.seenAtResolve.products.includes(key), `${key} must start before products resolves`);
  }
});

test('allocations start with the other material lookups', async () => {
  const db = fakeDb();
  await readinessBatch(LINES, undefined, db.qc);
  assert.ok(db.seenAtResolve.materials.includes('holds'), 'board_allocations must start before materials resolves');
});

test('a material the board mix adds is fetched with the rest', async () => {
  const db = fakeDb();
  await readinessBatch(LINES, undefined, db.qc);
  for (const key of ['materials', 'batches', 'incoming', 'holds']) {
    assert.ok(db.params[key][0].includes(77), `${key} must ask for the mix's material 77`);
  }
});

test('the ctx is identical to the sequential version', async () => {
  const now = await readinessBatch(LINES, undefined, fakeDb().qc);
  const ref = await sequentialReference(LINES, undefined, fakeDb().qc);
  assert.deepEqual(asPlain(now), asPlain(ref));
});

test('a single transaction client gives the same ctx', async () => {
  const serial = await readinessBatch(LINES, undefined, serialDb().qc);
  const ref = await sequentialReference(LINES, undefined, fakeDb().qc);
  assert.deepEqual(asPlain(serial), asPlain(ref));
});

test('a failing statement rejects readinessBatch', async () => {
  await assert.rejects(readinessBatch(LINES, undefined, fakeDb({ fail: 'tools' }).qc), /boom: tools/);
  await assert.rejects(readinessBatch(LINES, undefined, fakeDb({ fail: 'mix' }).qc), /boom: mix/);
});

test('no product, no statement', async () => {
  const db = fakeDb();
  const ctx = await readinessBatch([{ id: 1, product_id: null }], undefined, db.qc);
  assert.equal(db.started.length, 0);
  assert.equal(ctx.products.size, 0);
});

// ── Reference: readinessBatch as it was on main@57653fd4, verbatim ──────────────
// (default q/one replaced by the fake passed in; nothing else changed)
const q = () => { throw new Error('reference must use the qc it is given'); };
const one = q;
async function sequentialReference(lines, oc = one, qc = q) {
  const ctx = {
    products: new Map(), materials: new Map(), available: new Map(),
    tools: new Map(), shade: new Map(), incoming: new Map(), fg: new Map(),
    mix: new Map(), holds: new Map(), prAlloc: new Map(), plates: new Map(),
  };
  const productIds = [...new Set(lines.map(l => l.product_id).filter(x => x != null))];
  if (!productIds.length) return ctx;

  // Wave 1: masters, so spec overrides can resolve the effective board and tool.
  for (const p of await qc('SELECT * FROM products WHERE id = ANY($1)', [productIds])) {
    ctx.products.set(p.id, p);
  }
  const effective = lines.map(l => effectiveProduct(ctx.products.get(l.product_id), l));
  const materialIds = [...new Set(effective.map(p => p?.board_material_id).filter(x => x != null))];
  const toolIds = [...new Set(effective.map(p => p?.tool_id).filter(x => x != null))];

  // Wave 1.5: the mix, before wave 2 — a substitute board's stock is never
  // fetched unless its material id joins materialIds here.
  const lineIds = lines.map(l => l.id).filter(x => x != null);
  if (lineIds.length) {
    const plateRows = await qc(`SELECT tr.order_line_id,
        COUNT(prc.id)::int AS required,
        COUNT(prc.id) FILTER (WHERE prc.status IN
          ('verified_existing','available','reserved','issued'))::int AS ready
      FROM tooling_requests tr JOIN plate_request_components prc ON prc.tooling_request_id=tr.id
      WHERE tr.family='plate' AND tr.order_line_id=ANY($1::int[]) AND prc.status<>'cancelled'
      GROUP BY tr.order_line_id`, [lineIds]);
    for (const row of plateRows) ctx.plates.set(row.order_line_id, row);
  }
  const mixAll = lineIds.length
    ? await qc(`SELECT * FROM job_board_mix WHERE order_line_id = ANY($1) AND phase='plan'
                ORDER BY (role='planned') DESC, id`, [lineIds])
    : [];
  for (const r of mixAll) {
    if (!ctx.mix.has(r.order_line_id)) ctx.mix.set(r.order_line_id, []);
    ctx.mix.get(r.order_line_id).push(r);
  }
  for (const r of mixAll) if (!materialIds.includes(r.material_id)) materialIds.push(r.material_id);

  // Wave 2: everything keyed off those ids, in parallel.
  const [materials, batches, tools, shades, incoming, fg] = await Promise.all([
    qc('SELECT * FROM materials WHERE id = ANY($1)', [materialIds]),
    qc(`SELECT material_id, COALESCE(SUM(qty),0) AS q FROM stock_batches
        WHERE material_id = ANY($1) AND status='available' GROUP BY material_id`, [materialIds]),
    qc(`SELECT * FROM tools WHERE product_id = ANY($1) OR id = ANY($2) ORDER BY id`,
      [productIds, toolIds]),
    // One row per product: the same "latest active card" the per-line query took.
    qc(`SELECT DISTINCT ON (product_id) product_id, sc_number, status, revision_no, creation_date
        FROM shade_cards
        WHERE product_id = ANY($1) AND active=1 AND status NOT IN ('superseded','archived')
        ORDER BY product_id, id DESC`, [productIds]),
    qc(`SELECT m.id AS material_id,
               COALESCE(r.qty,0)::int + COALESCE(po.qty,0)::int AS qty
        FROM unnest($1::int[]) AS m(id)
        LEFT JOIN (SELECT material_id, SUM(qty) AS qty FROM requisitions
                   WHERE material_id = ANY($1) AND status IN ('pending','approved')
                   GROUP BY material_id) r ON r.material_id = m.id
        LEFT JOIN (SELECT pl.material_id, SUM(GREATEST(0, pl.qty - COALESCE(pl.received_qty,0))) AS qty
                   FROM po_lines pl JOIN purchase_orders po ON po.id=pl.purchase_order_id
                   WHERE pl.material_id = ANY($1) AND po.status IN ('open','partially_received')
                     AND NOT pl.closed_short
                   GROUP BY pl.material_id) po ON po.material_id = m.id`, [materialIds]),
    qc(`SELECT p.id AS product_id,
               COALESCE(SUM(fl.qty - fl.consumed_qty),0)::int AS qty
        FROM products p
        LEFT JOIN products fp ON ${fgMatchPredicate()}
        LEFT JOIN fg_lots fl ON fl.product_id = fp.id
             AND fl.status='verified' AND COALESCE(fl.retired,0)=0
             AND (fl.qty - fl.consumed_qty) > 0
        WHERE p.id = ANY($1)
        GROUP BY p.id`, [productIds]),
  ]);
  // Board already EARMARKED for a named job — every active stock hold on these
  // boards, with the job that holds it. Stock a planner tied to another job (or
  // that procurement's Cover action tied to the job that bought it) is not
  // available to this one; counting it would tell every job on the board that
  // one delivery covered them all. Only the LIST views resolve holds this way
  // (they alone pass a ctx) — the job-card release gate keeps reading raw
  // stock, so no card that releases today starts refusing.
  const holdRows = materialIds.length
    ? await qc(`SELECT a.material_id, a.order_line_id, a.qty, a.source, ol.gang_run_id
                FROM board_allocations a
                LEFT JOIN order_lines ol ON ol.id = a.order_line_id
                WHERE a.material_id = ANY($1) AND a.status='active'`, [materialIds])
    : [];
  for (const h of holdRows) {
    // Stock holds feed claimableQty as before; the requisition mirrors ride
    // alongside so a fresh_pr line can read its OWN incoming (not the board's).
    const bucket = h.source === 'stock' ? ctx.holds : ctx.prAlloc;
    if (!bucket.has(h.material_id)) bucket.set(h.material_id, []);
    bucket.get(h.material_id).push(h);
  }
  for (const m of materials) ctx.materials.set(m.id, m);
  for (const b of batches) ctx.available.set(b.material_id, b.q);
  for (const t of tools) {
    if (t.product_id != null) {
      if (!ctx.tools.has(t.product_id)) ctx.tools.set(t.product_id, []);
      ctx.tools.get(t.product_id).push(t);
    }
    ctx.tools.set(`id:${t.id}`, t);
  }
  for (const s of shades) ctx.shade.set(s.product_id, s);
  for (const i of incoming) ctx.incoming.set(i.material_id, i.qty);
  for (const f of fg) ctx.fg.set(f.product_id, f.qty);
  return ctx;
}
