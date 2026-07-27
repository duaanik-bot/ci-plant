// Inventory — stock position, batches, movements ledger, FG, adjustments.
import { Router } from 'express';
import { q, tx } from '../db.js';
import { audit } from '../helpers.js';
import { requireRole } from '../auth.js';
import { squash, squashSql } from '../search-key.js';

const r = Router();
const canAdjust = requireRole('planner');

r.get('/inventory/stock', async (_req, res, next) => {
  try {
    const rows = await q(`
      SELECT m.*, COALESCE(av.q,0) AS available, COALESCE(qr.q,0) AS quarantine,
             CASE WHEN ag.oldest IS NOT NULL
                  THEN FLOOR(EXTRACT(EPOCH FROM (now() - ag.oldest)) / 86400)::int END AS age_days,
             -- Board weight inputs. A leftover offcut inherits grade/gsm/pack from
             -- its parent board, but keeps its OWN strip size (sheet_l/sheet_w),
             -- so total weight = own strip area × parent gsm. These COALESCE
             -- aliases intentionally follow m.* and override the raw m.grade etc.
             COALESCE(m.grade, src.grade) AS grade,
             COALESCE(m.gsm, src.gsm) AS gsm,
             COALESCE(m.sheets_per_packet, src.sheets_per_packet) AS sheets_per_packet
      FROM materials m
      LEFT JOIN materials src ON src.id = m.source_material_id
      LEFT JOIN (SELECT material_id, SUM(qty) q FROM stock_batches WHERE status='available' GROUP BY material_id) av ON av.material_id=m.id
      LEFT JOIN (SELECT material_id, SUM(qty) q FROM stock_batches WHERE status='quarantine' GROUP BY material_id) qr ON qr.material_id=m.id
      LEFT JOIN (SELECT material_id, MIN(created_at) oldest FROM stock_batches WHERE status='available' AND qty>0 GROUP BY material_id) ag ON ag.material_id=m.id
      ORDER BY m.category, m.name`);
    // Committed demand is counted in PARENT (mother) sheets, because that is the
    // unit the warehouse stocks and the Available column reports. sheets_required
    // is the child print-sheet count, so falling back to it raw over-states demand
    // by children_per_parent. Mirrors the board picker below and dashboard.js.
    // Job-only board overrides win over the product master, same as everywhere else.
    const demand = await q(`
      SELECT COALESCE((ol.spec_override->>'board_material_id')::int, p.board_material_id) AS material_id,
             SUM(COALESCE(ol.parent_sheets_required, ol.sheets_required)) AS q
      FROM order_lines ol JOIN products p ON p.id=ol.product_id
      WHERE ol.status IN ('planned','ready') GROUP BY 1`);
    const dmap = Object.fromEntries(demand.map(d => [d.material_id, d.q]));
    res.json(rows.map(m => ({
      ...m, demand: dmap[m.id] || 0,
      short: (m.reorder_level > (m.available || 0)) || ((dmap[m.id] || 0) > (m.available || 0)),
    })));
  } catch (e) { next(e); }
});

// Per-order-line breakdown behind the /inventory/stock committed-demand
// number for one material — same override + parent-sheets rules as the
// aggregate at the top of this file, so the two MUST reconcile exactly.
r.get('/inventory/demand/:materialId', async (req, res, next) => {
  try {
    const materialId = +req.params.materialId;
    const lines = await q(`
      SELECT ol.id AS order_line_id,
             o.po_number, o.po_date, o.delivery_date,
             c.name AS customer_name,
             p.id AS product_id, p.name AS product_name, p.code AS product_code,
             p.party_artwork_code,
             ol.qty AS order_qty,
             COALESCE(ol.parent_sheets_required, ol.sheets_required) AS sheets_required,
             ol.sheets_required AS child_sheets_required,
             ol.planned_date, ol.status
      FROM order_lines ol
      JOIN products  p ON p.id = ol.product_id
      JOIN orders    o ON o.id = ol.order_id
      JOIN customers c ON c.id = o.customer_id
      WHERE ol.status IN ('planned','ready')
        AND COALESCE((ol.spec_override->>'board_material_id')::int, p.board_material_id) = $1
      ORDER BY ol.planned_date NULLS LAST, o.delivery_date, ol.id`, [materialId]);
    const [{ q: available }] = await q(
      `SELECT COALESCE(SUM(qty),0) AS q FROM stock_batches WHERE status='available' AND material_id=$1`,
      [materialId]);
    const total_sheets = lines.reduce((s, l) => s + Number(l.sheets_required || 0), 0);
    res.json({
      material_id: materialId,
      total_sheets,
      available: Number(available),
      shortfall: Math.max(0, total_sheets - Number(available)),
      lines,
    });
  } catch (e) { next(e); }
});

r.get('/inventory/batches', async (_req, res, next) => {
  try {
    res.json(await q(`
      SELECT b.*, m.name AS material_name, m.category
      FROM stock_batches b JOIN materials m ON m.id=b.material_id
      ORDER BY b.id DESC LIMIT 200`));
  } catch (e) { next(e); }
});

r.get('/inventory/movements', async (_req, res, next) => {
  try {
    res.json(await q(`
      SELECT sm.*, m.name AS material_name, p.name AS product_name
      FROM stock_movements sm
      LEFT JOIN materials m ON m.id=sm.material_id
      LEFT JOIN products p ON p.id=sm.product_id
      ORDER BY sm.id DESC LIMIT 300`));
  } catch (e) { next(e); }
});

r.get('/inventory/fg', async (_req, res, next) => {
  try {
    const rows = await q(`
      SELECT f.*, p.name AS product_name, p.code, p.rate, c.name AS customer_name
      FROM fg_stock f JOIN products p ON p.id=f.product_id
      JOIN customers c ON c.id=p.customer_id
      WHERE f.qty > 0 ORDER BY p.name`);
    // FG age in stock: plain fg_stock carries no date, so derive it FIFO — the
    // oldest production receipt still represented by the on-hand balance (walk
    // receipts newest-first, accumulate to the current qty, anchor on the last).
    const ids = rows.map(f => f.product_id);
    let recs = [];
    if (ids.length)
      recs = await q(`SELECT product_id, qty, created_at FROM stock_movements
                      WHERE type='fg_receipt' AND qty>0 AND product_id=ANY($1::int[])
                      ORDER BY created_at DESC`, [ids]);
    const byProd = {};
    for (const m of recs) (byProd[m.product_id] ||= []).push(m);
    const now = Date.now();
    res.json(rows.map(f => {
      let acc = 0, anchor = null;
      for (const m of (byProd[f.product_id] || [])) { acc += Number(m.qty); anchor = m.created_at; if (acc >= Number(f.qty)) break; }
      const age_days = anchor ? Math.floor((now - new Date(anchor).getTime()) / 86400000) : null;
      return { ...f, age_days };
    }));
  } catch (e) { next(e); }
});

// Leftover FG — finished-goods excess held as lots (Phase 2 gives them box
// numbers). Distinct from the RM board-offcut leftovers below.
r.get('/inventory/leftover-fg', async (_req, res, next) => {
  try {
    res.json(await q(`
      SELECT fl.id, fl.lot_number, fl.box_number, fl.kind, fl.status, fl.source, fl.created_at,
             fl.qty, fl.consumed_qty, (fl.qty - fl.consumed_qty) AS remaining,
             p.name AS product_name, p.code, c.name AS customer_name,
             jc.jc_number,
             FLOOR(EXTRACT(EPOCH FROM (now() - fl.created_at)) / 86400)::int AS age_days
      FROM fg_lots fl
      JOIN products p ON p.id=fl.product_id
      LEFT JOIN customers c ON c.id=p.customer_id
      LEFT JOIN job_cards jc ON jc.id=fl.job_card_id
      WHERE fl.kind='leftover' AND (fl.qty - fl.consumed_qty) > 0
      ORDER BY fl.created_at`));
  } catch (e) { next(e); }
});

// Paper warehouse browser for the Planning Engine — server-side search,
// filters and pagination so the planning screen never loads the whole
// warehouse. Committed demand honours job-only board overrides.
r.get('/warehouse/paper', async (req, res, next) => {
  try {
    const search = String(req.query.search || '').trim();
    const limit = Math.min(50, Math.max(1, +req.query.limit || 20));
    const page = Math.max(1, +req.query.page || 1);
    const childL = +req.query.child_l || 0;
    const childW = +req.query.child_w || 0;
    const inStock = req.query.in_stock !== '0';

    const where = [`m.category='board'`];
    const params = [];
    const add = v => { params.push(v); return `$${params.length}`; };
    if (search) {
      // Two passes, OR'd: the literal text as typed, plus the squashed key so
      // "2038" finds a board stored as 'Duplex GB · 296 GSM · 20 x 38'. The raw
      // ILIKE stays first so punctuation-dependent searches ('31.5', 'CI-BOX')
      // keep working — squashing only widens the result set. See search-key.js.
      const p = add(`%${search}%`);
      const clauses = [`m.name ILIKE ${p}`, `m.spec ILIKE ${p}`, `m.code ILIKE ${p}`];
      const key = squash(search);
      if (key) {
        const k = add(`%${key}%`);
        for (const col of ['m.name', 'm.spec', 'm.code']) clauses.push(`${squashSql(col)} LIKE ${k}`);
      }
      where.push(`(${clauses.join(' OR ')})`);
    }
    if (childL > 0 && childW > 0) {
      // Fit filter: the child must grid-fit the parent in either orientation.
      const l = add(childL), w = add(childW);
      where.push(`m.sheet_l > 0 AND m.sheet_w > 0 AND (
        (FLOOR(m.sheet_l/${l}) * FLOOR(m.sheet_w/${w})) > 0 OR
        (FLOOR(m.sheet_l/${w}) * FLOOR(m.sheet_w/${l})) > 0)`);
    }
    if (inStock) where.push(`COALESCE(av.q,0) > 0`);
    if (req.query.leftover_only === '1') where.push('m.leftover=1');
    // "In Leftover" is an include-toggle in the picker: on by default, and
    // unticking it hides leftover offcut masters from the results.
    if (req.query.exclude_leftover === '1') where.push('COALESCE(m.leftover,0)=0');

    const FROM = `
      FROM materials m
      LEFT JOIN (SELECT material_id, SUM(qty) AS q FROM stock_batches
                 WHERE status='available' GROUP BY material_id) av ON av.material_id=m.id
      LEFT JOIN (SELECT COALESCE((ol.spec_override->>'board_material_id')::int, p.board_material_id) AS mid,
                        SUM(COALESCE(ol.parent_sheets_required, ol.sheets_required)) AS q
                 FROM order_lines ol JOIN products p ON p.id=ol.product_id
                 WHERE ol.status IN ('planned','ready') GROUP BY 1) cm ON cm.mid=m.id
      LEFT JOIN (SELECT pl.material_id, SUM(GREATEST(0, pl.qty - pl.received_qty)) AS q
                 FROM po_lines pl JOIN purchase_orders po ON po.id=pl.purchase_order_id
                 WHERE po.status IN ('open','partially_received') GROUP BY 1) inc ON inc.material_id=m.id
      WHERE ${where.join(' AND ')}`;

    const [{ total }] = await q(`SELECT COUNT(*)::int AS total ${FROM}`, params);
    const rows = await q(`
      SELECT m.id, m.name, m.spec, m.sheet_l, m.sheet_w, m.unit, m.code, m.leftover,
             COALESCE(av.q,0) AS available, COALESCE(cm.q,0)::int AS committed,
             COALESCE(inc.q,0) AS incoming
      ${FROM}
      ORDER BY COALESCE(av.q,0) - COALESCE(cm.q,0) DESC, m.name
      LIMIT ${limit} OFFSET ${(page - 1) * limit}`, params);

    res.json({
      total, page, limit,
      rows: rows.map(r0 => ({ ...r0, free: Math.max(0, r0.available - r0.committed) })),
    });
  } catch (e) { next(e); }
});

// Manual adjustment (opening stock, count corrections) — still writes the ledger.
r.post('/inventory/adjust', canAdjust, async (req, res, next) => {
  try {
    const { material_id, qty, batch_no, note } = req.body;
    if (!material_id || !qty) return res.status(400).json({ error: 'Material and quantity are required' });
    await tx(async (qc, oc) => {
      const unit = (await oc('SELECT unit FROM materials WHERE id=$1', [material_id])).unit;
      if (qty > 0) {
        const [b] = await qc(
          `INSERT INTO stock_batches (material_id, batch_no, qty, initial_qty, unit, status)
           VALUES ($1,$2,$3,$3,$4,'available') RETURNING id`,
          [material_id, batch_no || `ADJ-${Date.now().toString().slice(-6)}`, qty, unit]);
        await qc(`INSERT INTO stock_movements (material_id, batch_id, type, qty, note) VALUES ($1,$2,'adjustment',$3,$4)`,
          [material_id, b.id, qty, note || 'Manual adjustment (in)']);
      } else {
        let remaining = -qty;
        const batches = await qc(
          `SELECT * FROM stock_batches WHERE material_id=$1 AND status='available' AND qty>0 ORDER BY created_at, id`,
          [material_id]);
        for (const b of batches) {
          if (remaining <= 0) break;
          const take = Math.min(b.qty, remaining);
          const newQty = b.qty - take;
          await qc(`UPDATE stock_batches SET qty=$1, status=$2 WHERE id=$3`,
            [newQty, newQty <= 0 ? 'exhausted' : 'available', b.id]);
          await qc(`INSERT INTO stock_movements (material_id, batch_id, type, qty, note) VALUES ($1,$2,'adjustment',$3,$4)`,
            [material_id, b.id, -take, note || 'Manual adjustment (out)']);
          remaining -= take;
        }
        // No hard block: a reduction beyond on-hand stock is allowed and pushes
        // the position negative (physical count corrections, untracked consumption
        // caught late). Book the shortfall as a negative adjustment batch so both
        // the stock position and the ledger reflect reality instead of rejecting.
        if (remaining > 0) {
          const [nb] = await qc(
            `INSERT INTO stock_batches (material_id, batch_no, qty, initial_qty, unit, status)
             VALUES ($1,$2,$3,$3,$4,'available') RETURNING id`,
            [material_id, `ADJ-NEG-${Date.now().toString().slice(-6)}`, -remaining, unit]);
          await qc(`INSERT INTO stock_movements (material_id, batch_id, type, qty, note) VALUES ($1,$2,'adjustment',$3,$4)`,
            [material_id, nb.id, -remaining, note || 'Manual adjustment (out, below zero)']);
        }
      }
      await audit('inventory', material_id, 'adjust', String(qty), qc, req.user.name);
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ── Warehouse aging — how long every batch and FG lot has been lying there ──
const AGE_BUCKETS = ['0-30', '31-60', '61-90', '90+'];
const bucketOf = d => d <= 30 ? '0-30' : d <= 60 ? '31-60' : d <= 90 ? '61-90' : '90+';

r.get('/inventory/aging', async (_req, res, next) => {
  try {
    const raw = await q(`
      SELECT b.id, b.batch_no, b.qty, b.unit, b.created_at,
             m.id AS material_id, m.name AS material_name, m.code, m.leftover, m.category,
             FLOOR(EXTRACT(EPOCH FROM (now() - b.created_at)) / 86400)::int AS age_days
      FROM stock_batches b JOIN materials m ON m.id=b.material_id
      WHERE b.status='available' AND b.qty > 0
      ORDER BY b.created_at`);
    const fg = await q(`
      SELECT fl.id, fl.lot_number, (fl.qty - fl.consumed_qty) AS qty, fl.created_at, fl.status,
             p.id AS product_id, p.name AS product_name, p.code,
             FLOOR(EXTRACT(EPOCH FROM (now() - fl.created_at)) / 86400)::int AS age_days
      FROM fg_lots fl JOIN products p ON p.id=fl.product_id
      WHERE fl.status IN ('pending_verification','verified') AND (fl.qty - fl.consumed_qty) > 0
      ORDER BY fl.created_at`);
    const sum = rows => Object.fromEntries(AGE_BUCKETS.map(k => {
      const hit = rows.filter(r0 => bucketOf(r0.age_days) === k);
      return [k, { count: hit.length, qty: hit.reduce((s, r0) => s + +r0.qty, 0) }];
    }));
    res.json({
      raw: raw.map(r0 => ({ ...r0, bucket: bucketOf(r0.age_days) })),
      fg: fg.map(r0 => ({ ...r0, bucket: bucketOf(r0.age_days) })),
      summary: { raw: sum(raw), fg: sum(fg) },
    });
  } catch (e) { next(e); }
});

// ── Leftover stock — dedicated view: masters with their dated lots ─────────
r.get('/inventory/leftovers', async (_req, res, next) => {
  try {
    const masters = await q(`
      SELECT m.*, src.name AS source_name, COALESCE(av.q,0) AS available,
             -- Offcut inherits grade/gsm/pack from its parent board but keeps its
             -- own strip size — total weight = own strip area × parent gsm. These
             -- aliases follow m.* deliberately and override the raw m.* columns.
             COALESCE(m.grade, src.grade) AS grade,
             COALESCE(m.gsm, src.gsm) AS gsm,
             COALESCE(m.sheets_per_packet, src.sheets_per_packet) AS sheets_per_packet
      FROM materials m
      LEFT JOIN materials src ON src.id=m.source_material_id
      LEFT JOIN (SELECT material_id, SUM(qty) q FROM stock_batches
                 WHERE status='available' GROUP BY material_id) av ON av.material_id=m.id
      WHERE m.leftover=1 ORDER BY m.name`);
    const lots = await q(`
      SELECT b.*, m.name AS material_name, m.code,
             FLOOR(EXTRACT(EPOCH FROM (now() - b.created_at)) / 86400)::int AS age_days
      FROM stock_batches b JOIN materials m ON m.id=b.material_id
      WHERE m.leftover=1 AND b.status='available' AND b.qty > 0
      ORDER BY b.created_at`);
    // A LO-PLAN- batch is booked at plan-lock and not yet cut ("planned");
    // once cutting completes it is renamed LO-<jc> and trued up ("confirmed").
    res.json({
      masters,
      lots: lots.map(l => ({
        ...l,
        bucket: bucketOf(l.age_days),
        origin: String(l.batch_no || '').startsWith('LO-PLAN-') ? 'planned' : 'confirmed',
      })),
    });
  } catch (e) { next(e); }
});

export default r;
