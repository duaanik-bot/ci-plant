// Demo seed — realistic pharma/FMCG carton data so every screen has life.
// Run `npm run seed` to wipe and re-seed.
import db from './db.js';
import { sheetsRequired, routingFor } from './helpers.js';

const TABLES = ['audit_log','dispatch_lines','dispatches','grns','po_lines','purchase_orders',
  'requisitions','fg_stock','stock_movements','stock_batches','job_stages','job_cards',
  'order_lines','orders','products','machines','materials','vendors','customers'];

export function seedIfEmpty() {
  const n = db.prepare('SELECT COUNT(*) AS n FROM customers').get().n;
  if (n === 0) seed();
}

export function seed() {
  db.transaction(() => {
    for (const t of TABLES) db.prepare(`DELETE FROM ${t}`).run();
    db.prepare(`DELETE FROM sqlite_sequence`).run();

    // Masters ────────────────────────────────────────────────────────────────
    const cust = db.prepare(`INSERT INTO customers (name, city, state, gstin, contact, phone, segment) VALUES (?,?,?,?,?,?,?)`);
    const C = {};
    C.medlife  = cust.run('Medlife Formulations', 'Baddi', 'Himachal Pradesh', '02AAACM1234F1Z5', 'Rajeev Sharma', '98150-11223', 'pharma').lastInsertRowid;
    C.zenith   = cust.run('Zenith Pharma', 'Panchkula', 'Haryana', '06AABCZ4321K1Z8', 'Meenakshi Gupta', '98760-44556', 'pharma').lastInsertRowid;
    C.novacure = cust.run('Novacure Labs', 'Ludhiana', 'Punjab', '03AABCN9876P1Z2', 'Harpreet Singh', '98140-77889', 'pharma').lastInsertRowid;
    C.sunrise  = cust.run('Sunrise Biotech', 'Chandigarh', 'Chandigarh', '04AABCS5555Q1Z1', 'Ankit Verma', '98550-22334', 'pharma').lastInsertRowid;
    C.crystal  = cust.run('Crystal Foods', 'Ambala', 'Haryana', '06AABCC7777R1Z9', 'Suresh Kumar', '98960-66778', 'fmcg').lastInsertRowid;
    C.himdairy = cust.run('Himalayan Dairy Co', 'Solan', 'Himachal Pradesh', '02AABCH8888S1Z3', 'Pooja Thakur', '98050-99001', 'fmcg').lastInsertRowid;

    const vend = db.prepare(`INSERT INTO vendors (name, city, contact, phone, categories) VALUES (?,?,?,?,?)`);
    const V = {};
    V.itc     = vend.run('ITC PSPD (Board)', 'Hyderabad', 'Regional Sales', '040-2333-1111', 'board').lastInsertRowid;
    V.century = vend.run('Century Pulp & Paper', 'Lalkuan', 'Dealer — Chandigarh', '98123-45678', 'board').lastInsertRowid;
    V.siegwerk= vend.run('Siegwerk Inks', 'Bhiwadi', 'Amit Jain', '98111-22334', 'ink').lastInsertRowid;
    V.foilco  = vend.run('Universal Foils', 'Delhi', 'Sanjay Arora', '98100-55667', 'foil,laminate').lastInsertRowid;
    V.pidilite= vend.run('Pidilite Industries', 'Mumbai', 'Distributor — Ludhiana', '98720-88990', 'adhesive').lastInsertRowid;

    const mat = db.prepare(`INSERT INTO materials (name, category, spec, unit, reorder_level) VALUES (?,?,?,?,?)`);
    const M = {};
    M.fbb300 = mat.run('FBB Board 300 GSM', 'board', 'ITC Cyber XLPac 300gsm 25x36"', 'sheets', 20000).lastInsertRowid;
    M.fbb270 = mat.run('FBB Board 270 GSM', 'board', 'ITC Cyber XLPac 270gsm 23x36"', 'sheets', 15000).lastInsertRowid;
    M.cfbb250= mat.run('CFBB Board 250 GSM', 'board', 'Century C1S 250gsm 25x36"', 'sheets', 10000).lastInsertRowid;
    M.duplex = mat.run('Duplex Board 350 GSM', 'board', 'Grey-back 350gsm 25x36"', 'sheets', 8000).lastInsertRowid;
    M.inkset = mat.run('Process Ink Set (CMYK)', 'ink', 'Siegwerk sheetfed offset', 'kg', 60).lastInsertRowid;
    M.goldfoil = mat.run('Gold Hot-Stamping Foil', 'foil', '110m x 640mm rolls', 'rolls', 12).lastInsertRowid;
    M.adhesive = mat.run('Pasting Adhesive', 'adhesive', 'Dendrite SH-grade', 'kg', 100).lastInsertRowid;
    M.bopp = mat.run('BOPP Gloss Lamination Film', 'laminate', '20 micron, 26" rolls', 'rolls', 10).lastInsertRowid;

    const mach = db.prepare(`INSERT INTO machines (name, type, capacity_per_hour, status) VALUES (?,?,?,?)`);
    const MC = {};
    MC.cd102 = mach.run('Heidelberg CD 102 (6-col + coater)', 'printing', 9000, 'running').lastInsertRowid;
    MC.rmgt  = mach.run('RMGT 920 (4-col)', 'printing', 7000, 'running').lastInsertRowid;
    MC.uv    = mach.run('UV Coating Line', 'coating', 5000, 'running').lastInsertRowid;
    MC.bobstFoil = mach.run('Bobst Foil & Emboss Press', 'foiling', 4000, 'running').lastInsertRowid;
    MC.sp102 = mach.run('Bobst SP 102 Die Cutter', 'die_cutting', 6500, 'running').lastInsertRowid;
    MC.ambition = mach.run('Bobst Ambition Folder Gluer', 'pasting', 25000, 'running').lastInsertRowid;

    const prod = db.prepare(`INSERT INTO products
      (customer_id, name, code, board_material_id, gsm, size, ups, wastage_pct, colors, coating, special, rate)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    const P = {};
    P.azith  = prod.run(C.medlife, 'Azithro-500 Tab Carton', 'PMC-1101', M.fbb300, 300, '85 x 40 x 22 mm', 24, 6, 4, 'uv', 'none', 2.85).lastInsertRowid;
    P.paracet= prod.run(C.medlife, 'Paracip-650 Tab Carton', 'PMC-1102', M.fbb270, 270, '80 x 35 x 20 mm', 28, 5, 3, 'aqueous', 'none', 2.10).lastInsertRowid;
    P.cough  = prod.run(C.zenith, 'Zencof Syrup Carton 100ml', 'PMC-2201', M.fbb300, 300, '50 x 50 x 118 mm', 12, 6, 5, 'uv', 'foil', 4.60).lastInsertRowid;
    P.derma  = prod.run(C.zenith, 'Zenderm Tube Carton 30g', 'PMC-2202', M.cfbb250, 250, '35 x 25 x 110 mm', 21, 5, 4, 'aqueous', 'none', 2.35).lastInsertRowid;
    P.inject = prod.run(C.novacure, 'Novacef-1g Injection Carton', 'PMC-3301', M.fbb300, 300, '58 x 42 x 78 mm', 15, 6, 4, 'uv', 'foil_emboss', 5.40).lastInsertRowid;
    P.capsule= prod.run(C.sunrise, 'Sunvit-D3 Capsule Carton', 'PMC-4401', M.fbb270, 270, '90 x 42 x 24 mm', 22, 5, 4, 'gloss_lam', 'none', 3.15).lastInsertRowid;
    P.tea    = prod.run(C.crystal, 'Crystal Green Tea 25s Carton', 'FMC-5501', M.duplex, 350, '75 x 65 x 130 mm', 8, 7, 6, 'matt_lam', 'emboss', 8.25).lastInsertRowid;
    P.ghee   = prod.run(C.himdairy, 'Him Ghee 500ml Carton', 'FMC-6601', M.duplex, 350, '95 x 95 x 110 mm', 6, 7, 5, 'gloss_lam', 'none', 9.80).lastInsertRowid;

    // Opening stock (available batches + ledger) ────────────────────────────
    const batch = db.prepare(`INSERT INTO stock_batches (material_id, batch_no, qty, initial_qty, unit, status, created_at)
      VALUES (?,?,?,?,?,'available', datetime('now','-20 day'))`);
    const move = db.prepare(`INSERT INTO stock_movements (material_id, batch_id, type, qty, note, created_at)
      VALUES (?,?,'adjustment',?,?, datetime('now','-20 day'))`);
    const openStock = [
      [M.fbb300, 'OP-FBB300-01', 68000], [M.fbb270, 'OP-FBB270-01', 41000],
      [M.cfbb250, 'OP-CFBB-01', 26000], [M.duplex, 'OP-DUP-01', 18000],
      [M.inkset, 'OP-INK-01', 240], [M.goldfoil, 'OP-FOIL-01', 30],
      [M.adhesive, 'OP-ADH-01', 420], [M.bopp, 'OP-BOPP-01', 26],
    ];
    for (const [mid, bno, q] of openStock) {
      const unit = db.prepare('SELECT unit FROM materials WHERE id=?').get(mid).unit;
      const b = batch.run(mid, bno, q, q, unit);
      move.run(mid, b.lastInsertRowid, q, 'Opening stock');
    }

    // Orders in every lifecycle state ────────────────────────────────────────
    const ord = db.prepare(`INSERT INTO orders (po_number, customer_id, po_date, delivery_date, status, created_at)
      VALUES (?,?,?,?,?, datetime('now','-'||?||' day'))`);
    const oline = db.prepare(`INSERT INTO order_lines
      (order_id, product_id, qty, rate, status, machine_id, planned_date, sheets_required,
       artwork_customer_ok, artwork_qa_ok, artwork_locked, tooling_ok, dispatched_qty)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const prodRow = id => db.prepare('SELECT * FROM products WHERE id=?').get(id);
    const d = off => { const t = new Date(); t.setDate(t.getDate() + off); return t.toISOString().slice(0, 10); };

    // O1 — fresh, pending planning
    const o1 = ord.run('MED/PO/2607', C.medlife, d(-2), d(12), 'open', 2).lastInsertRowid;
    oline.run(o1, P.azith, 150000, 2.85, 'pending', null, null, null, 0, 0, 0, 0, 0);
    oline.run(o1, P.paracet, 200000, 2.10, 'pending', null, null, null, 0, 0, 0, 0, 0);

    // O2 — planned, waiting artwork
    const o2 = ord.run('ZEN/PO/1188', C.zenith, d(-4), d(9), 'open', 4).lastInsertRowid;
    oline.run(o2, P.cough, 80000, 4.60, 'planned', MC.cd102, d(4), sheetsRequired(prodRow(P.cough), 80000), 1, 0, 0, 1, 0);
    oline.run(o2, P.derma, 120000, 2.35, 'planned', MC.rmgt, d(5), sheetsRequired(prodRow(P.derma), 120000), 0, 0, 0, 0, 0);

    // O3 — ready for production (all gates green)
    const o3 = ord.run('SUN/PO/0455', C.sunrise, d(-6), d(8), 'open', 6).lastInsertRowid;
    oline.run(o3, P.capsule, 100000, 3.15, 'ready', MC.rmgt, d(2), sheetsRequired(prodRow(P.capsule), 100000), 1, 1, 1, 1, 0);

    // O4 — in production (job card mid-way)
    const o4 = ord.run('NOV/PO/7821', C.novacure, d(-9), d(5), 'open', 9).lastInsertRowid;
    const l41 = oline.run(o4, P.inject, 60000, 5.40, 'in_production', MC.cd102, d(-1), sheetsRequired(prodRow(P.inject), 60000), 1, 1, 1, 1, 0).lastInsertRowid;

    // O5 — produced, waiting dispatch
    const o5 = ord.run('CRY/PO/3302', C.crystal, d(-14), d(1), 'open', 14).lastInsertRowid;
    const l51 = oline.run(o5, P.tea, 40000, 8.25, 'produced', MC.rmgt, d(-6), sheetsRequired(prodRow(P.tea), 40000), 1, 1, 1, 1, 0).lastInsertRowid;

    // O6 — fully dispatched / completed
    const o6 = ord.run('HIM/PO/0917', C.himdairy, d(-21), d(-4), 'completed', 21).lastInsertRowid;
    const l61 = oline.run(o6, P.ghee, 30000, 9.80, 'dispatched', MC.cd102, d(-12), sheetsRequired(prodRow(P.ghee), 30000), 1, 1, 1, 1, 30000).lastInsertRowid;

    // Job cards ──────────────────────────────────────────────────────────────
    const jc = db.prepare(`INSERT INTO job_cards
      (jc_number, order_line_id, product_id, machine_id, qty_planned, sheets_issued, qty_produced, qty_scrap, status, created_at, closed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    const stg = db.prepare(`INSERT INTO job_stages
      (job_card_id, seq, stage, status, unit, qty_in, qty_out, qty_scrap, operator, started_at, completed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    const now = off => { const t = new Date(); t.setDate(t.getDate() + off); return t.toISOString().slice(0, 19).replace('T', ' '); };

    // JC1 — Novacure injection carton, mid-production (foiling running)
    const injSheets = sheetsRequired(prodRow(P.inject), 60000);
    const jc1 = jc.run('CI-JC-0001', l41, P.inject, MC.cd102, 60000, injSheets, 0, 0, 'in_progress', now(-2), null).lastInsertRowid;
    const r1 = routingFor(prodRow(P.inject)); // printing, coating, foiling, embossing, die_cutting, pasting, qc
    let qin = injSheets;
    r1.forEach((s, i) => {
      const seq = i + 1;
      if (seq === 1) { stg.run(jc1, seq, s.stage, 'completed', s.unit, qin, qin - 120, 120, 'Ramesh', now(-2), now(-2)); qin = qin - 120; }
      else if (seq === 2) { stg.run(jc1, seq, s.stage, 'completed', s.unit, qin, qin - 45, 45, 'Vikas', now(-1), now(-1)); qin = qin - 45; }
      else if (seq === 3) { stg.run(jc1, seq, s.stage, 'in_progress', s.unit, qin, null, 0, 'Sohan', now(0), null); }
      else stg.run(jc1, seq, s.stage, 'pending', s.unit, null, null, 0, null, null, null);
    });
    // board consumption ledger for JC1
    db.prepare(`UPDATE stock_batches SET qty = qty - ? WHERE batch_no='OP-FBB300-01'`).run(injSheets);
    db.prepare(`INSERT INTO stock_movements (material_id, batch_id, type, qty, ref_type, ref_id, note, created_at)
      SELECT ?, id, 'consumption', ?, 'job_card', ?, 'Issue to CI-JC-0001', datetime('now','-2 day') FROM stock_batches WHERE batch_no='OP-FBB300-01'`)
      .run(M.fbb300, -injSheets, jc1);

    // JC2 — Crystal tea carton, closed, FG in stock
    const teaSheets = sheetsRequired(prodRow(P.tea), 40000);
    const jc2 = jc.run('CI-JC-0002', l51, P.tea, MC.rmgt, 40000, teaSheets, 39400, 780, 'closed', now(-7), now(-3)).lastInsertRowid;
    const r2 = routingFor(prodRow(P.tea)); // printing, coating, embossing, die_cutting, pasting, qc
    let q2 = teaSheets;
    r2.forEach((s, i) => {
      const seq = i + 1;
      const scrapAt = { 1: 130, 2: 40, 3: 55, 4: 60 }[seq] ?? 0;
      if (s.unit === 'sheets') {
        stg.run(jc2, seq, s.stage, 'completed', s.unit, q2, q2 - scrapAt, scrapAt, 'Team A', now(-6), now(-6));
        q2 = q2 - scrapAt;
      } else {
        const ups = prodRow(P.tea).ups;
        const cin = seq === r2.findIndex(x => x.unit === 'cartons') + 1 ? q2 * ups : q2;
        const scrapC = seq === r2.length ? 0 : 495;
        const cout = seq === r2.length ? 39400 : cin - scrapC;
        stg.run(jc2, seq, s.stage, 'completed', s.unit, cin, cout, seq === r2.length ? cin - 39400 : scrapC, 'Team B', now(-4), now(-3));
        q2 = cout;
      }
    });
    db.prepare(`UPDATE stock_batches SET qty = qty - ? WHERE batch_no='OP-DUP-01'`).run(teaSheets);
    db.prepare(`INSERT INTO stock_movements (material_id, batch_id, type, qty, ref_type, ref_id, note, created_at)
      SELECT ?, id, 'consumption', ?, 'job_card', ?, 'Issue to CI-JC-0002', datetime('now','-6 day') FROM stock_batches WHERE batch_no='OP-DUP-01'`)
      .run(M.duplex, -teaSheets, jc2);
    db.prepare(`INSERT INTO fg_stock (product_id, qty) VALUES (?,?)`).run(P.tea, 39400);
    db.prepare(`INSERT INTO stock_movements (product_id, type, qty, ref_type, ref_id, created_at)
      VALUES (?,?,?,?,?, datetime('now','-3 day'))`).run(P.tea, 'fg_receipt', 39400, 'job_card', jc2);

    // JC3 — Himalayan ghee, closed and dispatched
    const gheeSheets = sheetsRequired(prodRow(P.ghee), 30000);
    const jc3 = jc.run('CI-JC-0003', l61, P.ghee, MC.cd102, 30000, gheeSheets, 30000, 350, 'closed', now(-15), now(-10)).lastInsertRowid;
    const r3 = routingFor(prodRow(P.ghee));
    let q3 = gheeSheets;
    r3.forEach((s, i) => {
      const seq = i + 1;
      if (s.unit === 'sheets') { const sc = seq === 1 ? 200 : 50; stg.run(jc3, seq, s.stage, 'completed', s.unit, q3, q3 - sc, sc, 'Team A', now(-14), now(-13)); q3 -= sc; }
      else { const ups = prodRow(P.ghee).ups; const cin = s.stage === 'pasting' ? q3 * ups : q3; const cout = s.stage === 'qc' ? 30000 : cin - 60; stg.run(jc3, seq, s.stage, 'completed', s.unit, cin, cout, cin - cout, 'Team B', now(-12), now(-11)); q3 = cout; }
    });
    db.prepare(`UPDATE stock_batches SET qty = qty - ? WHERE batch_no='OP-DUP-01'`).run(gheeSheets);
    db.prepare(`INSERT INTO stock_movements (material_id, batch_id, type, qty, ref_type, ref_id, note, created_at)
      SELECT ?, id, 'consumption', ?, 'job_card', ?, 'Issue to CI-JC-0003', datetime('now','-14 day') FROM stock_batches WHERE batch_no='OP-DUP-01'`)
      .run(M.duplex, -gheeSheets, jc3);

    // Dispatch for O6 (ghee) — FG in and out
    const disp = db.prepare(`INSERT INTO dispatches (challan_number, order_id, customer_id, vehicle, driver, dispatched_at)
      VALUES (?,?,?,?,?, datetime('now','-9 day'))`).run('CI-CH-0001', o6, C.himdairy, 'PB-10-CJ-4521', 'Balwinder', ).lastInsertRowid;
    db.prepare(`INSERT INTO dispatch_lines (dispatch_id, order_line_id, product_id, qty) VALUES (?,?,?,?)`)
      .run(disp, l61, P.ghee, 30000);
    db.prepare(`INSERT INTO stock_movements (product_id, type, qty, ref_type, ref_id, created_at)
      VALUES (?,?,?,?,?, datetime('now','-10 day'))`).run(P.ghee, 'fg_receipt', 30000, 'job_card', jc3);
    db.prepare(`INSERT INTO stock_movements (product_id, type, qty, ref_type, ref_id, created_at)
      VALUES (?,?,?,?,?, datetime('now','-9 day'))`).run(P.ghee, 'dispatch', -30000, 'dispatch', disp);

    // Procurement — PR pending, PR approved, PO with quarantine GRN ─────────
    db.prepare(`INSERT INTO requisitions (pr_number, material_id, qty, needed_by, reason, status)
      VALUES ('CI-PR-0001', ?, 15000, ?, 'Duplex running low — upcoming FMCG orders', 'pending')`).run(M.duplex, d(7));
    db.prepare(`INSERT INTO requisitions (pr_number, material_id, qty, needed_by, reason, status)
      VALUES ('CI-PR-0002', ?, 40, ?, 'Gold foil for Novacure + Zenith foil jobs', 'approved')`).run(M.goldfoil, d(5));
    const pr3 = db.prepare(`INSERT INTO requisitions (pr_number, material_id, qty, needed_by, reason, status)
      VALUES ('CI-PR-0003', ?, 30000, ?, 'FBB 270 reorder point breached', 'converted')`).run(M.fbb270, d(3)).lastInsertRowid;
    const po1 = db.prepare(`INSERT INTO purchase_orders (po_number, vendor_id, requisition_id, status)
      VALUES ('CI-VPO-0001', ?, ?, 'open')`).run(V.itc, pr3).lastInsertRowid;
    const pol1 = db.prepare(`INSERT INTO po_lines (purchase_order_id, material_id, qty, rate) VALUES (?,?,?,?)`)
      .run(po1, M.fbb270, 30000, 6.85).lastInsertRowid;
    const g1 = db.prepare(`INSERT INTO grns (grn_number, purchase_order_id, po_line_id, material_id, qty, batch_no, status, received_at)
      VALUES ('CI-GRN-0001', ?, ?, ?, 12000, 'ITC-270-B447', 'quarantine', datetime('now','-1 day'))`)
      .run(po1, pol1, M.fbb270).lastInsertRowid;
    const gb = db.prepare(`INSERT INTO stock_batches (material_id, batch_no, qty, initial_qty, unit, status, grn_id, created_at)
      VALUES (?,?,?,?,'sheets','quarantine',?, datetime('now','-1 day'))`).run(M.fbb270, 'ITC-270-B447', 12000, 12000, g1).lastInsertRowid;
    db.prepare(`INSERT INTO stock_movements (material_id, batch_id, type, qty, ref_type, ref_id, note, created_at)
      VALUES (?,?,?,?,?,?,?, datetime('now','-1 day'))`)
      .run(M.fbb270, gb, 'grn', 12000, 'grn', g1, 'GRN CI-GRN-0001 (quarantine)');
  })();
  console.log('Seeded demo data.');
}

if (process.argv.includes('--force')) seed();
