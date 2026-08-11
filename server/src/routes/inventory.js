// Inventory — stock position, batches, movements ledger, FG, adjustments.
import { Router } from 'express';
import { q, tx } from '../db.js';
import { audit, issueWithWriteOn, BOARD_DEMAND_SQL, BOARD_DRAWN_EXISTS, EFF_BOARD_ID } from '../helpers.js';
import { requireRole } from '../auth.js';
import { squash, squashSql } from '../search-key.js';
import { COMMITTED_DEMAND_SQL, enrichStockRow, stockSplit } from '../replenishment.js';
import { repairMissingExtraSheetReturnsQuiet } from '../extra-sheet-returns.js';

const r = Router();
const canAdjust = requireRole('planner');

r.get('/inventory/stock', async (_req, res, next) => {
  try {
    await repairMissingExtraSheetReturnsQuiet();
    const rows = await q(`
      SELECT m.*, COALESCE(av.q,0) AS available, COALESCE(qr.q,0) AS quarantine,
             COALESCE(inc.q,0) AS incoming,
             -- Open write-ons against this board — the book was forced to nil
             -- because more left the warehouse than it said existed, and no
             -- storekeeper has physically recounted it yet. Distinct from a
             -- balance that reads zero because it was simply consumed clean.
             COALESCE((SELECT SUM(qty) FROM stock_writeons
                       WHERE material_id = m.id AND reconciled_at IS NULL), 0) AS open_writeon_qty,
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
      -- Incoming = still-open quantity on live purchase orders. A 'received' or
      -- 'closed' PO has nothing left to arrive, so only open and part-received
      -- POs count. GREATEST guards an over-receipt from subtracting stock that
      -- is already on the shelf.
      LEFT JOIN (
        SELECT pl.material_id, SUM(GREATEST(pl.qty - pl.received_qty, 0)) q
        FROM po_lines pl JOIN purchase_orders po ON po.id = pl.purchase_order_id
        WHERE po.status IN ('open','partially_received')
        GROUP BY pl.material_id
      ) inc ON inc.material_id = m.id
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
      WHERE ${BOARD_DEMAND_SQL} AND NOT ${BOARD_DRAWN_EXISTS} GROUP BY 1`);

    // WHAT THE PLANNING ENGINE HAS LOCKED, and what has been asked for to
    // cover it. These are the warehouse's own numbers and are deliberately NOT
    // derived from order-line status: a board is spoken for when a plan is made
    // and locked against it (a live board_allocations row), not when a line
    // happens to sit in a particular state.
    //
    //   committed_qty — board planning has fixed to jobs (COMMITTED_DEMAND_SQL),
    //                   net of what those jobs have already drawn
    //   pr_qty        — requisitions raised and not yet turned into a PO
    //                   (converted/closed ones have become the `incoming`
    //                   figure above, so counting them here would double up)
    const [locks, prs] = await Promise.all([
      q(COMMITTED_DEMAND_SQL),
      q(`SELECT material_id, COALESCE(SUM(qty),0) AS q, COUNT(*)::int AS n
         FROM requisitions
         WHERE status IN ('pending','approved') GROUP BY material_id`),
    ]);
    const lockMap = Object.fromEntries(locks.map(l => [l.material_id, l]));
    const prMap = Object.fromEntries(prs.map(p => [p.material_id, p]));
    const dmap = Object.fromEntries(demand.map(d => [d.material_id, d.q]));
    // Row assembly lives in replenishment.js so the number the warehouse shows,
    // the number the 360° drawer shows and the number the PR form seeds are one
    // function. `demand` is preserved alongside `reserved` for existing callers.
    //
    // The id lists ride alongside the totals so the strip can say how many
    // ORDER LINES and PRODUCTS a filtered set of boards covers. They cannot be
    // derived by adding the per-board counts: a line split across two boards
    // would be counted twice. The client unions them instead.
    res.json(rows.map(m => ({
      ...enrichStockRow(m, {
        reserved: dmap[m.id] || 0,
        incoming: m.incoming,
        committed_qty: Number(lockMap[m.id]?.q || 0),
        committed_lines: lockMap[m.id]?.n || 0,
        pr_qty: Number(prMap[m.id]?.q || 0),
        pr_count: prMap[m.id]?.n || 0,
      }),
      committed_line_ids: lockMap[m.id]?.line_ids || [],
      committed_product_ids: lockMap[m.id]?.product_ids || [],
    })));
  } catch (e) { next(e); }
});

// Per-order-line breakdown behind the /inventory/stock Frozen number for one
// material — same override + parent-sheets rules as the aggregate at the top
// of this file, so the two MUST reconcile exactly.
r.get('/inventory/demand/:materialId', async (req, res, next) => {
  try {
    const materialId = +req.params.materialId;
    const lines = await q(`
      SELECT ol.id AS order_line_id,
             o.po_number, o.po_date, o.delivery_date,
             c.name AS customer_name,
             p.id AS product_id, p.name AS product_name, p.code AS product_code,
             p.party_artwork_code, p.party_item_code,
             ol.qty AS order_qty,
             COALESCE(ol.parent_sheets_required, ol.sheets_required) AS sheets_required,
             ol.sheets_required AS child_sheets_required,
             ol.planned_date, ol.status
      FROM order_lines ol
      JOIN products  p ON p.id = ol.product_id
      JOIN orders    o ON o.id = ol.order_id
      JOIN customers c ON c.id = o.customer_id
      WHERE ${BOARD_DEMAND_SQL} AND NOT ${BOARD_DRAWN_EXISTS}
        AND COALESCE((ol.spec_override->>'board_material_id')::int, p.board_material_id) = $1
      ORDER BY ol.planned_date NULLS LAST, o.delivery_date, ol.id`, [materialId]);
    // THE DRAWER QUOTES THE ROW IT WAS OPENED FROM, and until now it did not.
    //
    // Its scalars were computed HERE and nowhere else: "committed" was the
    // listed lines' own nominal requirement summed up, and "shortfall" was that
    // sum minus GROSS shelf. That is a third demand definition, and it prints
    // one click away from the RM row, where Frozen is what planning has LOCKED
    // (capped at the shelf) and Shortfall is what it has locked BEYOND it. The
    // two disagree in both directions — a confident "Shortfall 0" beside a row
    // reading "Shortfall 3,000" — and the header above promises they reconcile.
    //
    // So the scalars now come off the SAME split the row uses, over the same
    // two aggregates. The line list below is untouched and still answers the
    // other question, "which jobs?" — it is the only place they are named.
    const [[{ q: available }], locks] = await Promise.all([
      q(`SELECT COALESCE(SUM(qty),0) AS q FROM stock_batches WHERE status='available' AND material_id=$1`,
        [materialId]),
      // Run whole and picked out, exactly as /inventory/stock does it.
      // COMMITTED_DEMAND_SQL is one statement carrying no parameter of its own,
      // and a narrowed hand-copy of it here would be a SECOND definition of the
      // frozen figure — precisely the drift this route's header forbids.
      q(COMMITTED_DEMAND_SQL),
    ]);
    const lock = locks.find(l => +l.material_id === materialId);
    const split = stockSplit({ available, committed_qty: Number(lock?.q || 0) });
    // Which of the listed jobs actually hold board on THIS material. A line the
    // planning engine split onto a second board, or a gang member whose run has
    // already drawn, is still a live claim worth listing — it is simply not
    // frozen here, and unflagged its sheets read as part of a Frozen total they
    // are not in.
    const frozenLines = new Set((lock?.line_ids || []).map(Number));
    res.json({
      material_id: materialId,
      available: Number(available),
      frozen: split.committed,
      shortfall: split.over_committed,
      lines: lines.map(l => ({ ...l, frozen: frozenLines.has(+l.order_line_id) })),
    });
  } catch (e) { next(e); }
});

r.get('/inventory/batches', async (_req, res, next) => {
  try {
    // sheets_per_packet rides along so the table can show what a pile's loose
    // figure would be if it has never been counted — b.loose_sheets NULL means
    // exactly that, and the packet size is the only way to derive it.
    res.json(await q(`
      SELECT b.*, m.name AS material_name, m.category, m.sheets_per_packet
      FROM stock_batches b JOIN materials m ON m.id=b.material_id
      ORDER BY b.id DESC LIMIT 200`));
  } catch (e) { next(e); }
});

// RECOUNT one pile's loose sheets — the deliberate correction of k.
//
// Loose is a ledger: it opens at the derived `qty mod P`, and every issue and
// return moves it from there (see helpers.js applyLoose). Like every ledger it
// can drift from the shelf, and like `qty`'s own stocktake this is how somebody
// who has physically counted puts it right.
//
// Absolute, not a delta — the counter is stating what is there, not what
// changed. Null clears it back to "never counted", which is a real answer: it
// restores the honest derivation rather than leaving a figure nobody stands
// behind. Clamped to the pile; the impossible-count guard in packetPlan then
// snaps a figure that cannot be true DOWN to one that can, so a miscount can
// never promise sheets that are not on the shelf.
r.post('/inventory/batches/:id/loose', canAdjust, async (req, res, next) => {
  try {
    const out = await tx(async (qc, oc) => {
      const b = await oc('SELECT * FROM stock_batches WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!b) throw Object.assign(new Error('Batch not found'), { status: 404 });
      const raw = req.body?.loose_sheets;
      let next_ = null;
      if (raw != null && raw !== '') {
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 0) throw Object.assign(
          new Error('Loose sheets must be a number of sheets, or blank to go back to the derived figure'), { status: 400 });
        next_ = Math.min(Math.floor(n), Math.max(0, Math.floor(Number(b.qty) || 0)));
      }
      await qc('UPDATE stock_batches SET loose_sheets=$1 WHERE id=$2', [next_, b.id]);
      const was = b.loose_sheets == null ? 'derived' : `${Math.round(Number(b.loose_sheets))}`;
      await audit('materials', b.material_id, 'loose_recount',
        `${b.batch_no}: loose sheets ${was} → ${next_ == null ? 'derived' : Math.round(next_)}`,
        qc, req.user.name);
      return { id: b.id, loose_sheets: next_ };
    });
    res.json(out);
  } catch (e) { next(e); }
});

r.get('/inventory/movements', async (_req, res, next) => {
  try {
    res.json(await q(`
      SELECT sm.*, m.name AS material_name, p.name AS product_name, p.code AS product_code,
             p.party_artwork_code, p.party_item_code
      FROM stock_movements sm
      LEFT JOIN materials m ON m.id=sm.material_id
      LEFT JOIN products p ON p.id=sm.product_id
      ORDER BY sm.id DESC LIMIT 300`));
  } catch (e) { next(e); }
});

r.get('/inventory/fg', async (_req, res, next) => {
  try {
    const rows = await q(`
      SELECT f.*, p.name AS product_name, p.code, p.party_artwork_code, p.party_item_code,
             p.rate, c.name AS customer_name
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
      SELECT fl.id, fl.product_id, fl.lot_number, fl.box_number, fl.kind, fl.status, fl.source, fl.created_at,
             fl.qty, fl.consumed_qty, (fl.qty - fl.consumed_qty) AS remaining,
             p.name AS product_name, p.code, p.party_artwork_code, p.party_item_code,
             c.name AS customer_name,
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
      -- Committed here must mean what it means in the Planning Engine: this
      -- picker IS the engine's Warehouse button, and two numbers under one word
      -- a single click apart is the confusion the claim work exists to end.
      -- The engine's Committed tile is open need PLUS stock holds
      -- (boardPositionView), so this is both arms of the same sum: what every
      -- live job is still waiting on, and every sheet already frozen on the
      -- shelf. Open need alone was the ACEBROBID arithmetic — a job whose
      -- board is fully frozen has open need 0, so its 8,959-sheet hold sat
      -- inside "Free 9,000" here while the tile one click away said Free 41,
      -- and the picker's green "enough" offered a plan the issue gate refuses.
      -- Not double-counted: open need is already net of the line's own holds,
      -- so a 700-need line holding 300 contributes 400 + 300. Requisition
      -- mirrors net open need but reserve no shelf, so only source='stock'
      -- rides in the second arm — issuableFor's own rule.
      LEFT JOIN (SELECT mid, SUM(reserved)::int AS q FROM (
                   SELECT mid, GREATEST(0, need - alloc) AS reserved FROM (
                     SELECT ${EFF_BOARD_ID} AS mid,
                            COALESCE(ol.parent_sheets_required, ol.sheets_required) AS need,
                            COALESCE((SELECT SUM(ba.qty) FROM board_allocations ba
                                       WHERE ba.order_line_id = ol.id AND ba.status='active'
                                         AND ba.material_id = ${EFF_BOARD_ID}), 0) AS alloc
                     FROM order_lines ol JOIN products p ON p.id=ol.product_id
                     WHERE ${BOARD_DEMAND_SQL} AND NOT ${BOARD_DRAWN_EXISTS}) d
                   UNION ALL
                   SELECT ba.material_id, ba.qty FROM board_allocations ba
                   WHERE ba.status='active' AND ba.source='stock') r
                 GROUP BY 1) cm ON cm.mid=m.id
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
        // A reduction beyond on-hand stock is still allowed — a physical count
        // correction or untracked consumption caught late is real. What is no
        // longer allowed is pushing the position negative: the shortfall is
        // written on to nil and raised for recount instead.
        await issueWithWriteOn(material_id, -qty, 'inventory', material_id,
          note || 'Manual adjustment (out)', qc, oc,
          { reason: note || 'Manual adjustment', user: req.user.name, unit });
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
             p.party_artwork_code, p.party_item_code,
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
             COALESCE(inc.q,0) AS incoming,
             -- The same open-write-on figure /inventory/stock carries. A leftover
             -- master is an ordinary materials row, so a job that issued more
             -- strip than the book held wrote one against it — and RECOUNT is the
             -- TOP rung of the Health ladder this list is about to render. Left
             -- out, the offcut list would show a Health column carrying a state
             -- it can never reach, and the one board that most needs counting
             -- would read OK.
             COALESCE((SELECT SUM(qty) FROM stock_writeons
                       WHERE material_id = m.id AND reconciled_at IS NULL), 0) AS open_writeon_qty,
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
      -- Still-open quantity on live purchase orders, same rule and same join as
      -- /inventory/stock. Nobody buys an offcut, so this is normally nil — it is
      -- here because enrichStockRow attaches an incoming figure either way, and
      -- a hard-coded zero stops being true the day somebody does.
      LEFT JOIN (
        SELECT pl.material_id, SUM(GREATEST(pl.qty - pl.received_qty, 0)) q
        FROM po_lines pl JOIN purchase_orders po ON po.id = pl.purchase_order_id
        WHERE po.status IN ('open','partially_received')
        GROUP BY pl.material_id
      ) inc ON inc.material_id = m.id
      WHERE m.leftover=1 ORDER BY m.name`);
    const lots = await q(`
      SELECT b.*, m.name AS material_name, m.code,
             FLOOR(EXTRACT(EPOCH FROM (now() - b.created_at)) / 86400)::int AS age_days
      FROM stock_batches b JOIN materials m ON m.id=b.material_id
      WHERE m.leftover=1 AND b.status='available' AND b.qty > 0
      ORDER BY b.created_at`);
    // A BANKED OFFCUT READ 100% FREE BY CONSTRUCTION until this line existed.
    // These rows never went through enrichStockRow, so `committed_qty` was
    // simply absent and stockSplit put every last sheet of the strip into Free
    // to Promise — a strip a locked plan has ALREADY frozen looked available to
    // promise to the next job. That is the double-promise the freeze exists to
    // stop, and it was hiding on the one sub-tab nobody enriched.
    //
    // The same two aggregates the RM stock list at the top of this file reads,
    // asked the same way, so the two sub-tabs of one screen can never disagree
    // about one master. Read-only: two SELECTs, no write path.
    //
    // `reserved` is deliberately NOT supplied here. It feeds `short` and
    // `suggested`, neither of which this list renders — the offcut row shows
    // Frozen, Free to Promise and Health, and all three come off `available`,
    // `committed_qty` and `open_writeon_qty`. Adding a third query for a figure
    // nothing reads is cost with no reader.
    const [locks, prs] = await Promise.all([
      q(COMMITTED_DEMAND_SQL),
      q(`SELECT material_id, COALESCE(SUM(qty),0) AS q, COUNT(*)::int AS n
         FROM requisitions
         WHERE status IN ('pending','approved') GROUP BY material_id`),
    ]);
    const lockMap = Object.fromEntries(locks.map(l => [l.material_id, l]));
    const prMap = Object.fromEntries(prs.map(p => [p.material_id, p]));
    // A LO-PLAN- batch is booked at plan-lock and not yet cut ("planned");
    // once cutting completes it is renamed LO-<jc> and trued up ("confirmed").
    res.json({
      masters: masters.map(m => enrichStockRow(m, {
        incoming: m.incoming,
        committed_qty: Number(lockMap[m.id]?.q || 0),
        committed_lines: lockMap[m.id]?.n || 0,
        pr_qty: Number(prMap[m.id]?.q || 0),
        pr_count: prMap[m.id]?.n || 0,
      })),
      lots: lots.map(l => ({
        ...l,
        bucket: bucketOf(l.age_days),
        origin: String(l.batch_no || '').startsWith('LO-PLAN-') ? 'planned' : 'confirmed',
      })),
    });
  } catch (e) { next(e); }
});

export default r;
