// Demo seed — realistic pharma/FMCG carton data so every screen has life.
// Run `npm run seed` to wipe and re-seed (users are kept).
import { init, q, one, tx } from './db.js';
import { sheetsRequired, routingFor } from './helpers.js';

const TABLES = ['payments','invoice_lines','invoices','audit_log','dispatch_lines','dispatches',
  'grns','po_lines','purchase_orders','requisitions','fg_stock','stock_movements','stock_batches',
  'job_stages','job_cards','order_lines','orders','products','machines','materials','vendors',
  'customers','employees'];

const d = off => { const t = new Date(); t.setDate(t.getDate() + off); return t.toISOString().slice(0, 10); };
const ts = off => { const t = new Date(); t.setDate(t.getDate() + off); return t.toISOString(); };

export async function seedIfEmpty() {
  const n = await one('SELECT COUNT(*)::int AS n FROM customers');
  if (n.n === 0) await seed();
  await seedEmployeesIfEmpty(); // non-destructive — new table on existing plants
  await seedSectionMachinesIfMissing();
  await seedSheetSizesIfMissing();
}

// Backfill parent/child sheet sizes on plants created before the sheet-size
// engine. Parent sizes follow the board spec; child print-sheet sizes are
// sensible defaults the planner can correct in Masters.
export async function seedSheetSizesIfMissing() {
  const boards = [
    ['FBB Board 300 GSM', 25, 36], ['FBB Board 270 GSM', 23, 36],
    ['CFBB Board 250 GSM', 25, 36], ['Duplex Board 350 GSM', 25, 36],
  ];
  for (const [name, l, w] of boards) {
    await q(`UPDATE materials SET sheet_l=$2, sheet_w=$3 WHERE name=$1 AND sheet_l IS NULL`, [name, l, w]);
  }
  const children = [
    ['PMC-1101', 18, 25], ['PMC-1102', 18, 23], ['PMC-2201', 18, 25], ['PMC-2202', 18, 23],
    ['PMC-3301', 18, 25], ['PMC-4401', 18, 23], ['FMC-5501', 20, 25], ['FMC-6601', 20, 25],
  ];
  for (const [code, l, w] of children) {
    await q(`UPDATE products SET child_l=$2, child_w=$3 WHERE code=$1 AND child_l IS NULL`, [code, l, w]);
  }
}

const CREW = [
  ['Jagtar Singh', 'operator', 'cutting', '98722-10000'],
  ['Rakesh Kumar', 'operator', 'printing', '98722-10001'],
  ['Vikram Chauhan', 'operator', 'printing', '98722-10002'],
  ['Manoj Tiwari', 'operator', 'coating', '98722-10003'],
  ['Ramesh Yadav', 'operator', 'lamination', '98722-10010'],
  ['Sohan Lal', 'operator', 'foiling', '98722-10004'],
  ['Deepak Rana', 'operator', 'embossing', '98722-10005'],
  ['Balwinder Singh', 'operator', 'die_cutting', '98722-10006'],
  ['Sunita Rani', 'helper', 'sorting', '98722-10011'],
  ['Geeta Devi', 'operator', 'pasting', '98722-10007'],
  ['Kuldeep Sharma', 'supervisor', null, '98722-10008'],
  ['Neha Kapoor', 'qc_inspector', 'qc', '98722-10009'],
];

// New-section machines — inserted only when that section has none, so
// existing plants pick them up without a reseed.
const SECTION_MACHINES = [
  ['Polar 115 Programmatic Cutter', 'cutting', 12000],
  ['Thermal Lamination Line', 'lamination', 4500],
];

export async function seedSectionMachinesIfMissing() {
  for (const [name, type, cap] of SECTION_MACHINES) {
    const n = await one('SELECT COUNT(*)::int AS n FROM machines WHERE type=$1', [type]);
    if (n.n === 0) await q('INSERT INTO machines (name, type, capacity_per_hour) VALUES ($1,$2,$3)', [name, type, cap]);
  }
}

export async function seedEmployeesIfEmpty() {
  const n = await one('SELECT COUNT(*)::int AS n FROM employees');
  if (n.n > 0) return;
  for (const [name, role, section, phone] of CREW) {
    await q('INSERT INTO employees (name, role, section, phone) VALUES ($1,$2,$3,$4)', [name, role, section, phone]);
  }
  console.log('Seeded plant crew (employees).');
}

export async function seed() {
  await tx(async (qc, oc) => {
    await qc(`TRUNCATE ${TABLES.join(',')} RESTART IDENTITY CASCADE`);
    const ins = async (sql, params) => (await qc(sql + ' RETURNING id', params))[0].id;

    // Masters ────────────────────────────────────────────────────────────────
    const cust = (n, ci, st, g, co, ph, s) =>
      ins('INSERT INTO customers (name, city, state, gstin, contact, phone, segment) VALUES ($1,$2,$3,$4,$5,$6,$7)', [n, ci, st, g, co, ph, s]);
    const C = {};
    C.medlife  = await cust('Medlife Formulations', 'Baddi', 'Himachal Pradesh', '02AAACM1234F1Z5', 'Rajeev Sharma', '98150-11223', 'pharma');
    C.zenith   = await cust('Zenith Pharma', 'Panchkula', 'Haryana', '06AABCZ4321K1Z8', 'Meenakshi Gupta', '98760-44556', 'pharma');
    C.novacure = await cust('Novacure Labs', 'Ludhiana', 'Punjab', '03AABCN9876P1Z2', 'Harpreet Singh', '98140-77889', 'pharma');
    C.sunrise  = await cust('Sunrise Biotech', 'Chandigarh', 'Chandigarh', '04AABCS5555Q1Z1', 'Ankit Verma', '98550-22334', 'pharma');
    C.crystal  = await cust('Crystal Foods', 'Ambala', 'Haryana', '06AABCC7777R1Z9', 'Suresh Kumar', '98960-66778', 'fmcg');
    C.himdairy = await cust('Himalayan Dairy Co', 'Solan', 'Himachal Pradesh', '02AABCH8888S1Z3', 'Pooja Thakur', '98050-99001', 'fmcg');

    const vend = (n, ci, co, ph, cat) =>
      ins('INSERT INTO vendors (name, city, contact, phone, categories) VALUES ($1,$2,$3,$4,$5)', [n, ci, co, ph, cat]);
    const V = {};
    V.itc      = await vend('ITC PSPD (Board)', 'Hyderabad', 'Regional Sales', '040-2333-1111', 'board');
    V.century  = await vend('Century Pulp & Paper', 'Lalkuan', 'Dealer — Chandigarh', '98123-45678', 'board');
    V.siegwerk = await vend('Siegwerk Inks', 'Bhiwadi', 'Amit Jain', '98111-22334', 'ink');
    V.foilco   = await vend('Universal Foils', 'Delhi', 'Sanjay Arora', '98100-55667', 'foil,laminate');
    V.pidilite = await vend('Pidilite Industries', 'Mumbai', 'Distributor — Ludhiana', '98720-88990', 'adhesive');

    const mat = (n, c, s, u, r, sl = null, sw = null) =>
      ins('INSERT INTO materials (name, category, spec, unit, reorder_level, sheet_l, sheet_w) VALUES ($1,$2,$3,$4,$5,$6,$7)', [n, c, s, u, r, sl, sw]);
    const M = {};
    M.fbb300  = await mat('FBB Board 300 GSM', 'board', 'ITC Cyber XLPac 300gsm 25x36"', 'sheets', 20000, 25, 36);
    M.fbb270  = await mat('FBB Board 270 GSM', 'board', 'ITC Cyber XLPac 270gsm 23x36"', 'sheets', 15000, 23, 36);
    M.cfbb250 = await mat('CFBB Board 250 GSM', 'board', 'Century C1S 250gsm 25x36"', 'sheets', 10000, 25, 36);
    M.duplex  = await mat('Duplex Board 350 GSM', 'board', 'Grey-back 350gsm 25x36"', 'sheets', 8000, 25, 36);
    M.inkset  = await mat('Process Ink Set (CMYK)', 'ink', 'Siegwerk sheetfed offset', 'kg', 60);
    M.goldfoil= await mat('Gold Hot-Stamping Foil', 'foil', '110m x 640mm rolls', 'rolls', 12);
    M.adhesive= await mat('Pasting Adhesive', 'adhesive', 'Dendrite SH-grade', 'kg', 100);
    M.bopp    = await mat('BOPP Gloss Lamination Film', 'laminate', '20 micron, 26" rolls', 'rolls', 10);

    const mach = (n, t, c, s) =>
      ins('INSERT INTO machines (name, type, capacity_per_hour, status) VALUES ($1,$2,$3,$4)', [n, t, c, s]);
    const MC = {};
    MC.polar    = await mach('Polar 115 Programmatic Cutter', 'cutting', 12000, 'running');
    MC.lam      = await mach('Thermal Lamination Line', 'lamination', 4500, 'running');
    MC.cd102    = await mach('Heidelberg CD 102 (6-col + coater)', 'printing', 9000, 'running');
    MC.rmgt     = await mach('RMGT 920 (4-col)', 'printing', 7000, 'running');
    MC.uv       = await mach('UV Coating Line', 'coating', 5000, 'running');
    MC.bobstFoil= await mach('Bobst Foil & Emboss Press', 'foiling', 4000, 'running');
    MC.sp102    = await mach('Bobst SP 102 Die Cutter', 'die_cutting', 6500, 'running');
    MC.ambition = await mach('Bobst Ambition Folder Gluer', 'pasting', 25000, 'running');

    const prod = (cid, n, code, bid, gsm, size, ups, w, col, coat, sp, rate) =>
      ins(`INSERT INTO products (customer_id, name, code, board_material_id, gsm, size, ups, wastage_pct, colors, coating, special, rate)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [cid, n, code, bid, gsm, size, ups, w, col, coat, sp, rate]);
    const P = {};
    P.azith   = await prod(C.medlife, 'Azithro-500 Tab Carton', 'PMC-1101', M.fbb300, 300, '85 x 40 x 22 mm', 24, 6, 4, 'uv', 'none', 2.85);
    P.paracet = await prod(C.medlife, 'Paracip-650 Tab Carton', 'PMC-1102', M.fbb270, 270, '80 x 35 x 20 mm', 28, 5, 3, 'aqueous', 'none', 2.10);
    P.cough   = await prod(C.zenith, 'Zencof Syrup Carton 100ml', 'PMC-2201', M.fbb300, 300, '50 x 50 x 118 mm', 12, 6, 5, 'uv', 'foil', 4.60);
    P.derma   = await prod(C.zenith, 'Zenderm Tube Carton 30g', 'PMC-2202', M.cfbb250, 250, '35 x 25 x 110 mm', 21, 5, 4, 'aqueous', 'none', 2.35);
    P.inject  = await prod(C.novacure, 'Novacef-1g Injection Carton', 'PMC-3301', M.fbb300, 300, '58 x 42 x 78 mm', 15, 6, 4, 'uv', 'foil_emboss', 5.40);
    P.capsule = await prod(C.sunrise, 'Sunvit-D3 Capsule Carton', 'PMC-4401', M.fbb270, 270, '90 x 42 x 24 mm', 22, 5, 4, 'gloss_lam', 'none', 3.15);
    P.tea     = await prod(C.crystal, 'Crystal Green Tea 25s Carton', 'FMC-5501', M.duplex, 350, '75 x 65 x 130 mm', 8, 7, 6, 'matt_lam', 'emboss', 8.25);
    P.ghee    = await prod(C.himdairy, 'Him Ghee 500ml Carton', 'FMC-6601', M.duplex, 350, '95 x 95 x 110 mm', 6, 7, 5, 'gloss_lam', 'none', 9.80);

    const prodRow = async id => await oc('SELECT * FROM products WHERE id=$1', [id]);

    // Tooling Hub — dies, plate sets, blocks & shade cards ──────────────────
    const tool = (family, code, title, pid, zone, x = {}) =>
      ins(`INSERT INTO tools (family, code, title, product_id, zone, maker, condition, location,
                              ups, sheet_size, carton_size, colors, emboss_type, shade_ref)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [family, code, title, pid, zone, x.maker ?? null, x.condition ?? 'Good',
         x.location ?? null, x.ups ?? null, x.sheet_size ?? null, x.carton_size ?? null,
         x.colors ?? null, x.emboss_type ?? null, x.shade_ref ?? null]);
    const dieFor = async (pid, code, ups, size, location, zone = 'in_rack', x = {}) => {
      const name = (await prodRow(pid)).name;
      const id = await tool('die', code, `${name} die`, pid, zone, { ups, carton_size: size, location, ...x });
      await qc('UPDATE products SET tool_id=$1 WHERE id=$2', [id, pid]);
    };
    await dieFor(P.azith,   'DIE-0001', 24, '85 x 40 x 22 mm',  'Rack A-01');
    await dieFor(P.paracet, 'DIE-0002', 28, '80 x 35 x 20 mm',  'Rack A-02');
    await dieFor(P.cough,   'DIE-0003', 12, '50 x 50 x 118 mm', 'Rack A-03');
    await dieFor(P.inject,  'DIE-0004', 15, '58 x 42 x 78 mm',  null, 'making', { maker: 'Sharma Die Makers' });
    await dieFor(P.tea,     'DIE-0005',  8, '75 x 65 x 130 mm', 'Rack B-01');
    await dieFor(P.ghee,    'DIE-0006',  6, '95 x 95 x 110 mm', 'Rack B-02');
    await tool('plate', 'PLT-0001', 'Azithro-500 plate set', P.azith, 'in_rack', { colors: 4, location: 'Plate Rack 1' });
    await tool('plate', 'PLT-0002', 'Zencof Syrup plate set', P.cough, 'making', { colors: 5, maker: 'CTP Bureau — Chandigarh' });
    await tool('block', 'BLK-0001', 'Zencof foil block', P.cough, 'in_rack', { emboss_type: 'foil', location: 'Block Drawer 2' });
    await tool('block', 'BLK-0002', 'Novacef foil+emboss block', P.inject, 'making', { emboss_type: 'foil_emboss', maker: 'Precision Engravers' });
    await tool('block', 'BLK-0003', 'Crystal Tea emboss block', P.tea, 'in_rack', { emboss_type: 'emboss', location: 'Block Drawer 1' });
    await tool('shade_card', 'SHD-0001', 'Azithro-500 shade card', P.azith, 'in_rack', { shade_ref: 'Pantone 2935C + 485C', location: 'QC Cabinet' });
    await tool('shade_card', 'SHD-0002', 'Him Ghee shade card', P.ghee, 'incoming', { shade_ref: 'Pantone 1235C' });

    // Opening stock (available batches + ledger) ─────────────────────────────
    const openStock = [
      [M.fbb300, 'OP-FBB300-01', 68000], [M.fbb270, 'OP-FBB270-01', 41000],
      [M.cfbb250, 'OP-CFBB-01', 26000], [M.duplex, 'OP-DUP-01', 18000],
      [M.inkset, 'OP-INK-01', 240], [M.goldfoil, 'OP-FOIL-01', 30],
      [M.adhesive, 'OP-ADH-01', 420], [M.bopp, 'OP-BOPP-01', 26],
    ];
    const batchIds = {};
    for (const [mid, bno, qty] of openStock) {
      const unit = (await oc('SELECT unit FROM materials WHERE id=$1', [mid])).unit;
      const bid = await ins(
        `INSERT INTO stock_batches (material_id, batch_no, qty, initial_qty, unit, status, created_at)
         VALUES ($1,$2,$3,$3,$4,'available',$5)`, [mid, bno, qty, unit, ts(-20)]);
      batchIds[bno] = bid;
      await qc(`INSERT INTO stock_movements (material_id, batch_id, type, qty, note, created_at)
                VALUES ($1,$2,'adjustment',$3,'Opening stock',$4)`, [mid, bid, qty, ts(-20)]);
    }

    // Orders in every lifecycle state ─────────────────────────────────────────
    const ord = (po, cid, pd, dd, st, off) =>
      ins('INSERT INTO orders (po_number, customer_id, po_date, delivery_date, status, created_at) VALUES ($1,$2,$3,$4,$5,$6)',
        [po, cid, pd, dd, st, ts(-off)]);
    const oline = (oid, pid, qty, rate, st, mid, pd, sh, c, qa, lk, tl, dq) =>
      ins(`INSERT INTO order_lines (order_id, product_id, qty, rate, status, machine_id, planned_date, sheets_required,
           artwork_customer_ok, artwork_qa_ok, artwork_locked, tooling_ok, dispatched_qty)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [oid, pid, qty, rate, st, mid, pd, sh, c, qa, lk, tl, dq]);

    const o1 = await ord('MED/PO/2607', C.medlife, d(-2), d(12), 'open', 2);
    await oline(o1, P.azith, 150000, 2.85, 'pending', null, null, null, 0, 0, 0, 0, 0);
    await oline(o1, P.paracet, 200000, 2.10, 'pending', null, null, null, 0, 0, 0, 0, 0);

    const o2 = await ord('ZEN/PO/1188', C.zenith, d(-4), d(9), 'open', 4);
    await oline(o2, P.cough, 80000, 4.60, 'planned', MC.cd102, d(4), sheetsRequired(await prodRow(P.cough), 80000), 1, 0, 0, 1, 0);
    await oline(o2, P.derma, 120000, 2.35, 'planned', MC.rmgt, d(5), sheetsRequired(await prodRow(P.derma), 120000), 0, 0, 0, 0, 0);

    const o3 = await ord('SUN/PO/0455', C.sunrise, d(-6), d(8), 'open', 6);
    await oline(o3, P.capsule, 100000, 3.15, 'ready', MC.rmgt, d(2), sheetsRequired(await prodRow(P.capsule), 100000), 1, 1, 1, 1, 0);

    const o4 = await ord('NOV/PO/7821', C.novacure, d(-9), d(5), 'open', 9);
    const l41 = await oline(o4, P.inject, 60000, 5.40, 'in_production', MC.cd102, d(-1), sheetsRequired(await prodRow(P.inject), 60000), 1, 1, 1, 1, 0);

    const o5 = await ord('CRY/PO/3302', C.crystal, d(-14), d(1), 'open', 14);
    const l51 = await oline(o5, P.tea, 40000, 8.25, 'produced', MC.rmgt, d(-6), sheetsRequired(await prodRow(P.tea), 40000), 1, 1, 1, 1, 0);

    const o6 = await ord('HIM/PO/0917', C.himdairy, d(-21), d(-4), 'completed', 21);
    const l61 = await oline(o6, P.ghee, 30000, 9.80, 'dispatched', MC.cd102, d(-12), sheetsRequired(await prodRow(P.ghee), 30000), 1, 1, 1, 1, 30000);

    // Job cards ───────────────────────────────────────────────────────────────
    const jc = (no, lid, pid, mid, qp, sh, qpr, qs, st, ca, cl) =>
      ins(`INSERT INTO job_cards (jc_number, order_line_id, product_id, machine_id, qty_planned, sheets_issued, qty_produced, qty_scrap, status, created_at, closed_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [no, lid, pid, mid, qp, sh, qpr, qs, st, ca, cl]);
    const stg = (jcid, seq, s, st, u, qi, qo, qs, op, sa, cmp) =>
      qc(`INSERT INTO job_stages (job_card_id, seq, stage, status, unit, qty_in, qty_out, qty_scrap, operator, started_at, completed_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [jcid, seq, s, st, u, qi, qo, qs, op, sa, cmp]);
    const consume = async (batchNo, mid, sheets, jcid, jcNo, when) => {
      await qc(`UPDATE stock_batches SET qty = qty - $1 WHERE batch_no=$2`, [sheets, batchNo]);
      await qc(`INSERT INTO stock_movements (material_id, batch_id, type, qty, ref_type, ref_id, note, created_at)
                VALUES ($1,$2,'consumption',$3,'job_card',$4,$5,$6)`,
        [mid, batchIds[batchNo], -sheets, jcid, `Issue to ${jcNo}`, when]);
    };

    // JC1 — Novacure injection carton, mid-production (foiling running)
    const inj = await prodRow(P.inject);
    const injSheets = sheetsRequired(inj, 60000);
    const jc1 = await jc('CI-JC-0001', l41, P.inject, MC.cd102, 60000, injSheets, 0, 0, 'in_progress', ts(-2), null);
    let qin = injSheets;
    const r1 = routingFor(inj);
    for (let i = 0; i < r1.length; i++) {
      const seq = i + 1, s = r1[i];
      if (seq === 1) { await stg(jc1, seq, s.stage, 'completed', s.unit, qin, qin - 120, 120, 'Ramesh', ts(-2), ts(-2)); qin -= 120; }
      else if (seq === 2) { await stg(jc1, seq, s.stage, 'completed', s.unit, qin, qin - 45, 45, 'Vikas', ts(-1), ts(-1)); qin -= 45; }
      else if (seq === 3) { await stg(jc1, seq, s.stage, 'in_progress', s.unit, qin, null, 0, 'Sohan', ts(0), null); }
      else await stg(jc1, seq, s.stage, 'pending', s.unit, null, null, 0, null, null, null);
    }
    await consume('OP-FBB300-01', M.fbb300, injSheets, jc1, 'CI-JC-0001', ts(-2));

    // JC2 — Crystal tea carton, closed, FG in stock
    const tea = await prodRow(P.tea);
    const teaSheets = sheetsRequired(tea, 40000);
    const jc2 = await jc('CI-JC-0002', l51, P.tea, MC.rmgt, 40000, teaSheets, 39400, 780, 'closed', ts(-7), ts(-3));
    const r2 = routingFor(tea);
    let q2 = teaSheets;
    let firstCartonSeq = r2.findIndex(x => x.unit === 'cartons') + 1;
    for (let i = 0; i < r2.length; i++) {
      const seq = i + 1, s = r2[i];
      if (s.unit === 'sheets') {
        const sc = { 1: 130, 2: 40, 3: 55, 4: 60 }[seq] ?? 0;
        await stg(jc2, seq, s.stage, 'completed', s.unit, q2, q2 - sc, sc, 'Team A', ts(-6), ts(-6));
        q2 -= sc;
      } else {
        const cin = seq === firstCartonSeq ? q2 * tea.ups : q2;
        const isLast = seq === r2.length;
        const cout = isLast ? 39400 : cin - 495;
        await stg(jc2, seq, s.stage, 'completed', s.unit, cin, cout, cin - cout, 'Team B', ts(-4), ts(-3));
        q2 = cout;
      }
    }
    await consume('OP-DUP-01', M.duplex, teaSheets, jc2, 'CI-JC-0002', ts(-6));
    await qc('INSERT INTO fg_stock (product_id, qty) VALUES ($1,$2)', [P.tea, 39400]);
    await qc(`INSERT INTO stock_movements (product_id, type, qty, ref_type, ref_id, created_at)
              VALUES ($1,'fg_receipt',$2,'job_card',$3,$4)`, [P.tea, 39400, jc2, ts(-3)]);

    // JC3 — Himalayan ghee, closed and dispatched
    const ghee = await prodRow(P.ghee);
    const gheeSheets = sheetsRequired(ghee, 30000);
    const jc3 = await jc('CI-JC-0003', l61, P.ghee, MC.cd102, 30000, gheeSheets, 30000, 350, 'closed', ts(-15), ts(-10));
    const r3 = routingFor(ghee);
    let q3 = gheeSheets;
    firstCartonSeq = r3.findIndex(x => x.unit === 'cartons') + 1;
    for (let i = 0; i < r3.length; i++) {
      const seq = i + 1, s = r3[i];
      if (s.unit === 'sheets') {
        const sc = seq === 1 ? 200 : 50;
        await stg(jc3, seq, s.stage, 'completed', s.unit, q3, q3 - sc, sc, 'Team A', ts(-14), ts(-13));
        q3 -= sc;
      } else {
        const cin = seq === firstCartonSeq ? q3 * ghee.ups : q3;
        const isLast = seq === r3.length;
        const cout = isLast ? 30000 : cin - 60;
        await stg(jc3, seq, s.stage, 'completed', s.unit, cin, cout, cin - cout, 'Team B', ts(-12), ts(-11));
        q3 = cout;
      }
    }
    await consume('OP-DUP-01', M.duplex, gheeSheets, jc3, 'CI-JC-0003', ts(-14));

    const disp = await ins(
      `INSERT INTO dispatches (challan_number, order_id, customer_id, vehicle, driver, dispatched_at)
       VALUES ('CI-CH-0001',$1,$2,'PB-10-CJ-4521','Balwinder',$3)`, [o6, C.himdairy, ts(-9)]);
    await qc('INSERT INTO dispatch_lines (dispatch_id, order_line_id, product_id, qty) VALUES ($1,$2,$3,$4)',
      [disp, l61, P.ghee, 30000]);
    await qc(`INSERT INTO stock_movements (product_id, type, qty, ref_type, ref_id, created_at)
              VALUES ($1,'fg_receipt',$2,'job_card',$3,$4)`, [P.ghee, 30000, jc3, ts(-10)]);
    await qc(`INSERT INTO stock_movements (product_id, type, qty, ref_type, ref_id, created_at)
              VALUES ($1,'dispatch',$2,'dispatch',$3,$4)`, [P.ghee, -30000, disp, ts(-9)]);

    // Procurement — PR pending, PR approved, PO with quarantine GRN ──────────
    await qc(`INSERT INTO requisitions (pr_number, material_id, qty, needed_by, reason, status)
              VALUES ('CI-PR-0001',$1,15000,$2,'Duplex running low — upcoming FMCG orders','pending')`, [M.duplex, d(7)]);
    await qc(`INSERT INTO requisitions (pr_number, material_id, qty, needed_by, reason, status)
              VALUES ('CI-PR-0002',$1,40,$2,'Gold foil for Novacure + Zenith foil jobs','approved')`, [M.goldfoil, d(5)]);
    const pr3 = await ins(`INSERT INTO requisitions (pr_number, material_id, qty, needed_by, reason, status)
              VALUES ('CI-PR-0003',$1,30000,$2,'FBB 270 reorder point breached','converted')`, [M.fbb270, d(3)]);
    const po1 = await ins(`INSERT INTO purchase_orders (po_number, vendor_id, requisition_id, status)
              VALUES ('CI-VPO-0001',$1,$2,'open')`, [V.itc, pr3]);
    const pol1 = await ins('INSERT INTO po_lines (purchase_order_id, material_id, qty, rate) VALUES ($1,$2,30000,6.85)', [po1, M.fbb270]);
    const g1 = await ins(`INSERT INTO grns (grn_number, purchase_order_id, po_line_id, material_id, qty, batch_no, status, received_at)
              VALUES ('CI-GRN-0001',$1,$2,$3,12000,'ITC-270-B447','quarantine',$4)`, [po1, pol1, M.fbb270, ts(-1)]);
    const gb = await ins(`INSERT INTO stock_batches (material_id, batch_no, qty, initial_qty, unit, status, grn_id, created_at)
              VALUES ($1,'ITC-270-B447',12000,12000,'sheets','quarantine',$2,$3)`, [M.fbb270, g1, ts(-1)]);
    await qc(`INSERT INTO stock_movements (material_id, batch_id, type, qty, ref_type, ref_id, note, created_at)
              VALUES ($1,$2,'grn',12000,'grn',$3,'GRN CI-GRN-0001 (quarantine)',$4)`, [M.fbb270, gb, g1, ts(-1)]);
  });
  console.log('Seeded demo data.');
}

if (process.argv.includes('--force')) {
  await init();
  await seed();
  process.exit(0);
}
