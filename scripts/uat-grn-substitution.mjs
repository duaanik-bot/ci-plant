// UAT: receive a different GSM against a purchase order, end to end.
//
// Runs against its OWN embedded Postgres on a private port in a scratch data
// directory — never the production database, and never the shared :5439 another
// session may be holding. Everything it creates is prefixed UAT- and torn down
// at the end; the data directory is deleted outright.
//
//   node scripts/uat-grn-substitution.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';

const PORT = 5482;
const dataDir = path.join(os.tmpdir(), `ci-erp-uat-grn-sub-${PORT}`);

const { default: EmbeddedPostgres } = await import('embedded-postgres');
fs.rmSync(dataDir, { recursive: true, force: true });
const epg = new EmbeddedPostgres({
  databaseDir: dataDir, user: 'postgres', password: 'postgres',
  port: PORT, persistent: false, onError: () => {},
});
console.log(`▸ starting a private Postgres on :${PORT}`);
await epg.initialise();
await epg.start();
await epg.createDatabase('cierp');

process.env.DATABASE_URL = `postgresql://postgres:postgres@localhost:${PORT}/cierp`;
process.env.JWT_SECRET = 'uat-grn-substitution-secret';

const { init, q, one } = await import('../server/src/db.js');

// Stopping Postgres kills every pooled connection, and pg surfaces that as an
// unhandled 'error' on the pool — which would crash the run AFTER a clean pass
// and report a false failure. Once teardown starts, that noise is expected.
let tearingDown = false;
let exitCode = 1;
for (const ev of ['uncaughtException', 'unhandledRejection']) {
  process.on(ev, e => {
    if (tearingDown) process.exit(exitCode);
    console.error(`✗ ${ev}:`, e);
    process.exit(1);
  });
}
const { default: app } = await import('../server/src/app.js');
const jwt = (await import('jsonwebtoken')).default;
await init();
console.log('▸ schema built');

// ── harness ─────────────────────────────────────────────────────────────────
const server = app.listen(0);
await new Promise(r => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}/api`;
const token = jwt.sign({ id: 1, name: 'UAT Runner', role: 'admin' }, process.env.JWT_SECRET);

const call = (method, url, body) => new Promise((resolve, reject) => {
  const data = body ? JSON.stringify(body) : null;
  const req = http.request(`${base}${url}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
    },
  }, res => {
    let out = '';
    res.on('data', c => (out += c));
    res.on('end', () => {
      let parsed = null;
      try { parsed = out ? JSON.parse(out) : null; } catch { parsed = out; }
      resolve({ status: res.statusCode, body: parsed });
    });
  });
  req.on('error', reject);
  if (data) req.write(data);
  req.end();
});

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};

const created = { materials: [], products: [], orders: [], lines: [], reqs: [], pos: [], poLines: [], grns: [], customers: [], vendors: [] };

try {
  // ── fixture ───────────────────────────────────────────────────────────────
  console.log('\n▸ seeding the UAT fixture');
  const b300 = await one(`INSERT INTO materials (name, code, category, unit, grade, gsm, sheet_l, sheet_w, sheets_per_packet, active, leftover)
    VALUES ('UAT FBB 300 GSM 23x36','UAT2336300FBB','board','sheets','UAT-FBB',300,23,36,144,1,0) RETURNING *`);
  const b290 = await one(`INSERT INTO materials (name, code, category, unit, grade, gsm, sheet_l, sheet_w, sheets_per_packet, active, leftover)
    VALUES ('UAT FBB 290 GSM 23x36','UAT2336290FBB','board','sheets','UAT-FBB',290,23,36,144,1,0) RETURNING *`);
  // Same grade, BIGGER sheet — a 23x36 parent still comes out of it, trimmed.
  const bBig = await one(`INSERT INTO materials (name, code, category, unit, grade, gsm, sheet_l, sheet_w, sheets_per_packet, active, leftover)
    VALUES ('UAT FBB 300 GSM 25x36','UAT2536300FBB','board','sheets','UAT-FBB',300,25,36,144,1,0) RETURNING *`);
  // Same grade, too SMALL — no guillotine gets a 23x36 parent out of 20x30.
  const bSmall = await one(`INSERT INTO materials (name, code, category, unit, grade, gsm, sheet_l, sheet_w, sheets_per_packet, active, leftover)
    VALUES ('UAT FBB 300 GSM 20x30','UAT2030300FBB','board','sheets','UAT-FBB',300,20,30,144,1,0) RETURNING *`);
  // A DIFFERENT grade — must never be offered, on any axis.
  const bGrade = await one(`INSERT INTO materials (name, code, category, unit, grade, gsm, sheet_l, sheet_w, sheets_per_packet, active, leftover)
    VALUES ('UAT SAFFIRE 300 GSM 23x36','UAT2336300SAF','board','sheets','UAT-SAFFIRE',300,23,36,144,1,0) RETURNING *`);
  created.materials.push(b300.id, b290.id, bBig.id, bSmall.id, bGrade.id);

  const cust = await one(`INSERT INTO customers (name) VALUES ('UAT Nikos') RETURNING *`);
  created.customers.push(cust.id);
  const vend = await one(`INSERT INTO vendors (name) VALUES ('UAT Paper Mill') RETURNING *`);
  created.vendors.push(vend.id);

  const mkProduct = (name, code) => one(
    `INSERT INTO products (name, code, customer_id, board_material_id, ups, parent_l, parent_w, child_l, child_w)
     VALUES ($1,$2,$3,$4,1,23,36,11,12) RETURNING *`, [name, code, cust.id, b300.id]);
  const pNikos = await mkProduct('UAT Nikos 5', 'UAT-NIKOS-5');
  const pSwiss = await mkProduct('UAT Swiss C-12', 'UAT-SWISS-12');
  const pGarn  = await mkProduct('UAT Garnier 40', 'UAT-GARN-40');
  // No parent on file — its parent IS whatever board it is given, so a size
  // change re-plans it. Must be locked on the size axis, free on the GSM axis.
  const pNoParent = await one(
    `INSERT INTO products (name, code, customer_id, board_material_id, ups, parent_l, parent_w, child_l, child_w)
     VALUES ('UAT No Parent','UAT-NOPARENT',$1,$2,1,NULL,NULL,11,12) RETURNING *`, [cust.id, b300.id]);
  created.products.push(pNikos.id, pSwiss.id, pGarn.id, pNoParent.id);

  const ord = await one(`INSERT INTO orders (po_number, customer_id, po_date, status)
    VALUES ('UAT-ORD-1',$1,'2026-08-06','pending') RETURNING *`, [cust.id]);
  created.orders.push(ord.id);
  const mkLine = (product, sheets) => one(
    `INSERT INTO order_lines (order_id, product_id, qty, rate, sheets_required, parent_sheets_required, status)
     VALUES ($1,$2,1000,10,$3,$3,'planned') RETURNING *`, [ord.id, product.id, sheets]);
  const lNikos = await mkLine(pNikos, 14400);
  const lSwiss = await mkLine(pSwiss, 4000);
  const lGarn  = await mkLine(pGarn, 3000);
  const lNoParent = await mkLine(pNoParent, 2000);
  created.lines.push(lNikos.id, lSwiss.id, lGarn.id, lNoParent.id);

  // PR → PO → PO line, for 100 packets (14,400 sheets) of the 300 GSM.
  const pr = await one(`INSERT INTO requisitions (pr_number, material_id, qty, status, order_line_id)
    VALUES ('UAT-PR-1',$1,14400,'converted',$2) RETURNING *`, [b300.id, lNikos.id]);
  created.reqs.push(pr.id);
  const po = await one(`INSERT INTO purchase_orders (po_number, vendor_id, requisition_id, status)
    VALUES ('UAT-PO-1',$1,$2,'open') RETURNING *`, [vend.id, pr.id]);
  created.pos.push(po.id);
  const poLine = await one(`INSERT INTO po_lines (purchase_order_id, material_id, qty, rate, received_qty)
    VALUES ($1,$2,14400,2.94,0) RETURNING *`, [po.id, b300.id]);
  created.poLines.push(poLine.id);

  // Nikos is covered BY THIS PR; Swiss also has an incoming PR on the same PO.
  const pr2 = await one(`INSERT INTO requisitions (pr_number, material_id, qty, status, order_line_id)
    VALUES ('UAT-PR-2',$1,4000,'converted',$2) RETURNING *`, [b300.id, lSwiss.id]);
  created.reqs.push(pr2.id);
  await q(`UPDATE purchase_orders SET requisition_id=$1 WHERE id=$2`, [pr.id, po.id]);
  await q(`UPDATE requisitions SET purchase_order_id=$1 WHERE id = ANY($2)`, [po.id, [pr.id, pr2.id]]);
  await q(`INSERT INTO board_allocations (material_id, order_line_id, qty, source, requisition_id, reason)
           VALUES ($1,$2,14400,'requisition',$3,'UAT incoming')`, [b300.id, lNikos.id, pr.id]);
  await q(`INSERT INTO board_allocations (material_id, order_line_id, qty, source, requisition_id, reason)
           VALUES ($1,$2,4000,'requisition',$3,'UAT incoming')`, [b300.id, lSwiss.id, pr2.id]);

  // Garnier has already had its board issued to the floor → must be ineligible.
  const jc = await one(`INSERT INTO job_cards (jc_number, order_line_id, product_id, qty_planned, sheets_issued, status)
    VALUES ('UAT-JC-1',$1,$2,1000,3000,'open') RETURNING *`, [lGarn.id, pGarn.id]);
  const batch = await one(`INSERT INTO stock_batches (material_id, batch_no, qty, initial_qty, unit, status)
    VALUES ($1,'UAT-B-OLD',3000,3000,'sheets','available') RETURNING *`, [b300.id]);
  await q(`INSERT INTO stock_movements (material_id, batch_id, type, qty, ref_type, ref_id, note)
           VALUES ($1,$2,'consumption',$3,'job_card',$4,'UAT issue to floor')`, [b300.id, batch.id, 3000, jc.id]);
  await q(`UPDATE order_lines SET status='in_production' WHERE id=$1`, [lGarn.id]);

  console.log(`  fixture: 300GSM #${b300.id} → 290GSM #${b290.id}, PO line #${poLine.id}`);

  // ── 1. candidates ─────────────────────────────────────────────────────────
  console.log('\n▸ 1. the GSM ladder is offered, nothing else');
  const cand = await call('GET', `/grns/substitution-candidates?po_line_id=${poLine.id}`);
  const ids = (cand.body.candidates || []).map(c => c.id);
  check('the 290 GSM at the same size is offered', ids.includes(b290.id));
  check('a BIGGER sheet of the same grade is offered', ids.includes(bBig.id));
  check('a smaller sheet of the same grade is offered (the JOB decides, not the list)', ids.includes(bSmall.id));
  check('a different GRADE is never offered', !ids.includes(bGrade.id));
  check('the ordered board is not offered as its own substitute', !ids.includes(b300.id));
  check('same-size candidates sort first', (cand.body.candidates || [])[0]?.id === b290.id,
    String((cand.body.candidates || [])[0]?.name));

  // ── 2. preview ────────────────────────────────────────────────────────────
  console.log('\n▸ 2. the preview lists what the board was covering');
  const pv = await call('GET',
    `/grns/substitution-preview?po_line_id=${poLine.id}&material_id=${b290.id}&qty=15840&picks=${lNikos.id}`);
  const claims = pv.body.claims || [];
  const byId = id => claims.find(c => c.id === id);
  check('Nikos is listed as bought for by this PO', byId(lNikos.id)?.bought === true);
  check('Swiss is listed as bought for by this PO', byId(lSwiss.id)?.bought === true);
  check('Garnier is listed but INELIGIBLE — board already issued',
    byId(lGarn.id) && byId(lGarn.id).eligible === false, JSON.stringify(byId(lGarn.id)?.reason));
  check('110 packets is reported for 15,840 sheets', pv.body.received?.packets === 110, String(pv.body.received?.packets));
  check('the over-receipt settles the PO line', pv.body.balance?.closes === true);
  check('the plan is executable', pv.body.ok === true, JSON.stringify(pv.body.blockers));

  // ── 3. an ineligible pick is refused ──────────────────────────────────────
  console.log('\n▸ 3. a job whose board has gone to the floor cannot be picked');
  const bad = await call('POST', '/grns/substitute', {
    po_line_id: poLine.id, material_id: b290.id, qty: 15840, picks: [lNikos.id, lGarn.id],
  });
  check('refused with 409', bad.status === 409, `got ${bad.status}`);
  check('no GRN was written', (await q(`SELECT COUNT(*)::int n FROM grns`))[0].n === 0);

  // ── 4. commit ─────────────────────────────────────────────────────────────
  console.log('\n▸ 4. receiving the board that actually arrived');
  const done = await call('POST', '/grns/substitute', {
    po_line_id: poLine.id, material_id: b290.id, qty: 15840, picks: [lNikos.id],
    batch_no: 'UAT-BATCH-290', received_by: 'UAT Runner',
  });
  check('accepted', done.status === 200, JSON.stringify(done.body));
  const grn = await one(`SELECT * FROM grns WHERE id=$1`, [done.body.grn_id]);
  created.grns.push(grn.id);
  check('the GRN carries the board that LANDED', grn.material_id === b290.id);
  check('the GRN remembers what was ordered', grn.substituted_for_material_id === b300.id);

  const stockBatch = await one(`SELECT * FROM stock_batches WHERE grn_id=$1`, [grn.id]);
  check('the quarantine batch is the 290 GSM', stockBatch.material_id === b290.id);
  check('the batch holds 15,840 sheets', +stockBatch.qty === 15840);

  const nikos = await one(`SELECT spec_override FROM order_lines WHERE id=$1`, [lNikos.id]);
  check('Nikos now runs on the 290 GSM', +nikos.spec_override?.board_material_id === b290.id,
    JSON.stringify(nikos.spec_override));
  const swiss = await one(`SELECT spec_override FROM order_lines WHERE id=$1`, [lSwiss.id]);
  check('un-ticked Swiss was NOT re-boarded', !swiss.spec_override?.board_material_id);

  const aNikos = await one(`SELECT * FROM board_allocations WHERE order_line_id=$1 AND status='active'`, [lNikos.id]);
  check('Nikos\'s allocation was repointed to the 290 GSM', aNikos?.material_id === b290.id);
  const aSwiss = await one(`SELECT * FROM board_allocations WHERE order_line_id=$1 AND status='active'`, [lSwiss.id]);
  check('un-ticked Swiss\'s incoming allocation was RELEASED — it reads short again', !aSwiss,
    aSwiss ? `still active on material ${aSwiss.material_id}` : '');

  // ── 5. QC burn-down — the reason the repoint exists ───────────────────────
  console.log('\n▸ 5. QC releases the stock and the allocation burns down exactly once');
  const qcRes = await call('POST', `/grns/${grn.id}/qc`, { accept: true, note: 'UAT accept' });
  check('QC accepted', qcRes.status === 200, JSON.stringify(qcRes.body));
  const afterQc = await one(`SELECT * FROM board_allocations WHERE order_line_id=$1 AND status='active'`, [lNikos.id]);
  check('Nikos is no longer double-credited — the incoming allocation is gone', !afterQc,
    afterQc ? `still active qty ${afterQc.qty}` : '');
  const relBatch = await one(`SELECT status FROM stock_batches WHERE grn_id=$1`, [grn.id]);
  check('the 290 GSM is available stock', relBatch.status === 'available');
  const line = await one(`SELECT received_qty FROM po_lines WHERE id=$1`, [poLine.id]);
  check('the PO line records the substituted receipt', +line.received_qty === 15840, String(line.received_qty));

  // ── 6. write off + delete ─────────────────────────────────────────────────
  console.log('\n▸ 6. writing the dummy entries off');
  const rb = await call('POST', `/grns/${grn.id}/rollback`);
  check('the substituted GRN rolls back', rb.status === 200, JSON.stringify(rb.body));
  check('its stock batch is gone', !(await one(`SELECT id FROM stock_batches WHERE grn_id=$1`, [grn.id])));
  check('the PO line balance is restored', +(await one(`SELECT received_qty FROM po_lines WHERE id=$1`, [poLine.id])).received_qty === 0);

  // Put Nikos back on the ordered board so the size axis starts from a clean
  // slate — the GSM run above moved it, and rollback does not un-re-board.
  await q(`UPDATE order_lines SET spec_override=NULL WHERE id = ANY($1)`, [created.lines]);
  await q(`INSERT INTO board_allocations (material_id, order_line_id, qty, source, requisition_id, reason)
           VALUES ($1,$2,14400,'requisition',$3,'UAT incoming')`, [b300.id, lNikos.id, pr.id]);

  // ── 7. the SIZE axis — a bigger sheet the parent still comes out of ───────
  console.log('\n▸ 7. a BIGGER sheet: the parent is trimmed out, nothing else moves');
  const pvBig = await call('GET',
    `/grns/substitution-preview?po_line_id=${poLine.id}&material_id=${bBig.id}&qty=14400&picks=${lNikos.id}`);
  const bigBy = id => (pvBig.body.claims || []).find(c => c.id === id);
  check('Nikos (23x36 parent) is eligible on a 25x36 sheet', bigBy(lNikos.id)?.eligible === true,
    bigBy(lNikos.id)?.reason);
  check('the trim it costs is reported', bigBy(lNikos.id)?.trim?.short_edge === 2,
    JSON.stringify(bigBy(lNikos.id)?.trim));
  check('8% of each sheet is reported wasted', bigBy(lNikos.id)?.trim?.waste_pct === 8,
    String(bigBy(lNikos.id)?.trim?.waste_pct));
  check('the no-parent job is LOCKED on a size change', bigBy(lNoParent.id)?.eligible === false);
  check('and told to set the parent in Planning',
    /no parent sheet on file/i.test(bigBy(lNoParent.id)?.reason || ''), bigBy(lNoParent.id)?.reason);
  check('the sheet count is untouched — the job keeps its own parent',
    bigBy(lNikos.id)?.parent_sheets_required === 14400, String(bigBy(lNikos.id)?.parent_sheets_required));

  // ── 8. a sheet the parent cannot come out of ──────────────────────────────
  console.log('\n▸ 8. a sheet too small: every job on it is refused');
  const pvSmall = await call('GET',
    `/grns/substitution-preview?po_line_id=${poLine.id}&material_id=${bSmall.id}&qty=14400&picks=`);
  const smallNikos = (pvSmall.body.claims || []).find(c => c.id === lNikos.id);
  check('Nikos is refused on a 20x30 sheet', smallNikos?.eligible === false);
  check('the refusal names both sheets', /23×36.*20×30/.test(smallNikos?.reason || ''), smallNikos?.reason);
  check('with no job ticked the receipt is still valid — the board still arrives',
    pvSmall.body.ok === true, JSON.stringify(pvSmall.body.blockers));

  const forced = await call('POST', '/grns/substitute', {
    po_line_id: poLine.id, material_id: bSmall.id, qty: 14400, picks: [lNikos.id],
  });
  check('ticking a job onto a sheet it cannot use is refused with 409', forced.status === 409,
    `got ${forced.status}`);

  // ── 9. committing a size substitution ─────────────────────────────────────
  console.log('\n▸ 9. receiving the bigger sheet for real');
  const doneBig = await call('POST', '/grns/substitute', {
    po_line_id: poLine.id, material_id: bBig.id, qty: 14400, picks: [lNikos.id], batch_no: 'UAT-BATCH-25x36',
  });
  check('accepted', doneBig.status === 200, JSON.stringify(doneBig.body));
  const grnBig = await one(`SELECT * FROM grns WHERE id=$1`, [doneBig.body.grn_id]);
  created.grns.push(grnBig.id);
  check('the GRN carries the 25x36 that landed', grnBig.material_id === bBig.id);
  check('and remembers the 23x36 that was ordered', grnBig.substituted_for_material_id === b300.id);
  const nikosBig = await one(`SELECT spec_override FROM order_lines WHERE id=$1`, [lNikos.id]);
  check('Nikos now runs on the 25x36 board', +nikosBig.spec_override?.board_material_id === bBig.id);
  const allocBig = await one(`SELECT * FROM board_allocations WHERE order_line_id=$1 AND status='active'`, [lNikos.id]);
  check('its allocation followed the board', allocBig?.material_id === bBig.id);
  check('its sheet requirement did NOT change — same parent, same cut',
    +(await one(`SELECT parent_sheets_required FROM order_lines WHERE id=$1`, [lNikos.id])).parent_sheets_required === 14400);

  // The allocation repoint has to survive the size axis too, or the same
  // double-credit reappears here: QC matches on material_id, and Nikos's
  // allocation is now on the 25x36.
  const qcBig = await call('POST', `/grns/${grnBig.id}/qc`, { accept: true, note: 'UAT accept (size)' });
  check('QC accepts the size substitution', qcBig.status === 200, JSON.stringify(qcBig.body));
  check('the allocation burns down on the size axis as well — no double credit',
    !(await one(`SELECT id FROM board_allocations WHERE order_line_id=$1 AND status='active'`, [lNikos.id])));

  // Rollback is for an ACCEPTED receipt; a quarantine one is deleted instead.
  const rbBig = await call('POST', `/grns/${grnBig.id}/rollback`);
  check('the size substitution rolls back too',
    rbBig.status === 200 && !(await one(`SELECT id FROM stock_batches WHERE grn_id=$1`, [grnBig.id])),
    `status ${rbBig.status} ${JSON.stringify(rbBig.body)}`);
} catch (e) {
  failures++;
  console.error('\n✗ UAT threw:', e);
} finally {
  // ── teardown — strictly by the ids created, never an unscoped DELETE ──────
  console.log('\n▸ deleting the UAT rows');
  const del = async (sql, params) => { try { await q(sql, params); } catch (e) { console.log(`  (${e.message})`); } };
  await del(`DELETE FROM stock_movements WHERE material_id = ANY($1)`, [created.materials]);
  await del(`DELETE FROM stock_batches   WHERE material_id = ANY($1)`, [created.materials]);
  await del(`DELETE FROM grns            WHERE id = ANY($1)`, [created.grns]);
  await del(`DELETE FROM board_allocations WHERE order_line_id = ANY($1)`, [created.lines]);
  await del(`DELETE FROM job_cards       WHERE order_line_id = ANY($1)`, [created.lines]);
  // purchase_orders.requisition_id and requisitions.purchase_order_id point at
  // each other, so neither can be deleted first — break the cycle, then unwind.
  await del(`UPDATE purchase_orders SET requisition_id=NULL  WHERE id = ANY($1)`, [created.pos]);
  await del(`UPDATE requisitions SET purchase_order_id=NULL, order_line_id=NULL WHERE id = ANY($1)`, [created.reqs]);
  await del(`DELETE FROM requisition_lines WHERE requisition_id = ANY($1)`, [created.reqs]);
  await del(`DELETE FROM po_lines        WHERE id = ANY($1)`, [created.poLines]);
  await del(`DELETE FROM purchase_orders WHERE id = ANY($1)`, [created.pos]);
  await del(`DELETE FROM requisitions    WHERE id = ANY($1)`, [created.reqs]);
  await del(`DELETE FROM board_verifications WHERE material_id = ANY($1)`, [created.materials]);
  await del(`DELETE FROM order_lines     WHERE id = ANY($1)`, [created.lines]);
  await del(`DELETE FROM orders          WHERE id = ANY($1)`, [created.orders]);
  await del(`DELETE FROM products        WHERE id = ANY($1)`, [created.products]);
  await del(`DELETE FROM materials       WHERE id = ANY($1)`, [created.materials]);
  await del(`DELETE FROM customers       WHERE id = ANY($1)`, [created.customers]);
  await del(`DELETE FROM vendors         WHERE id = ANY($1)`, [created.vendors]);

  const left = await q(`SELECT
      (SELECT COUNT(*)::int FROM materials  WHERE code LIKE 'UAT%')   AS materials,
      (SELECT COUNT(*)::int FROM products   WHERE code LIKE 'UAT-%')  AS products,
      (SELECT COUNT(*)::int FROM grns       WHERE grn_number LIKE 'CI-GRN-%') AS grns,
      (SELECT COUNT(*)::int FROM board_allocations) AS allocations`);
  console.log('  remaining UAT rows:', JSON.stringify(left[0]));
  const clean = Object.values(left[0]).every(n => n === 0);
  check('every UAT row is gone', clean, JSON.stringify(left[0]));

  console.log(`\n${failures === 0 ? '✓ UAT PASSED' : `✗ UAT FAILED — ${failures} check(s)`}`);
  exitCode = failures === 0 ? 0 : 1;
  tearingDown = true;
  server.close();
  await epg.stop().catch(() => {});
  fs.rmSync(dataDir, { recursive: true, force: true });
  process.exit(exitCode);
}
