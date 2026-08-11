// Dashboard KPIs + Reports. Live queries — no refresh buttons, no pivots.
import { Router } from 'express';
import { q, one } from '../db.js';
import { plantDay, plantMonth, plantDateStr, plantRange } from '../plant-calendar.js';
import { BOARD_MIX_POSITION_BY_LINE_LATERAL, EFF_BOARD_ID } from '../helpers.js';

const r = Router();

r.get('/dashboard', async (_req, res, next) => {
  try {
    // Plant-local (IST) day and month windows, passed as half-open ranges so
    // the timestamp columns stay index-usable — see plant-calendar.js.
    const day = plantDay();
    const mon = plantMonth();

    // All KPI queries are independent — run them concurrently so the page cost
    // is one pool round-trip, not nineteen sequential ones.
    const [
      ordersInHand, wip, wipByStage, closedToday, producedMonth, scrap,
      shortages, readyDispatch, onTime, dispatchedMonth, machines,
      shortLines, xsOpen, dueSoon, awPending,
      bottleneck, machineUtil, operatorProd, recentJobs,
    ] = await Promise.all([
      one(`
      SELECT COUNT(*)::int AS lines, COALESCE(SUM((qty-dispatched_qty)*rate),0) AS value,
             COALESCE(SUM(qty-dispatched_qty),0)::int AS qty
      FROM order_lines WHERE status NOT IN ('dispatched','cancelled')`),

      one(`SELECT COUNT(*)::int AS jobs FROM job_cards WHERE status IN ('open','in_progress')`),

      q(`
      SELECT js.stage, COUNT(*)::int AS n FROM job_stages js
      JOIN job_cards jc ON jc.id=js.job_card_id
      WHERE jc.status IN ('open','in_progress') AND js.status IN ('in_progress','partially_completed')
      GROUP BY js.stage`),

      one(`
      SELECT COUNT(*)::int AS jobs, COALESCE(SUM(qty_produced),0)::int AS cartons
      FROM job_cards WHERE status='closed' AND closed_at >= $1 AND closed_at < $2`,
        [day.start, day.end]),

      one(`
      SELECT COALESCE(SUM(qty_produced),0)::int AS qty FROM job_cards
      WHERE status='closed' AND closed_at >= $1 AND closed_at < $2`, [mon.start, mon.end]),

      one(`
      SELECT COALESCE(SUM(js.qty_scrap),0)::int AS scrap, COALESCE(SUM(js.qty_in),0)::int AS input
      FROM job_stages js WHERE js.status='completed'
        AND js.completed_at >= $1 AND js.completed_at < $2`, [mon.start, mon.end]),

      one(`
      SELECT COUNT(*)::int AS n FROM (
        SELECT m.id FROM materials m
        LEFT JOIN (SELECT material_id, SUM(qty) q FROM stock_batches WHERE status='available' GROUP BY material_id) av ON av.material_id=m.id
        -- Demand lands on the board the line will ACTUALLY run on. Keyed on
        -- the product master alone, a line whose planner picked a different
        -- board in the engine billed its sheets to the master's board and left
        -- the real one looking idle — and 'Unspecified board' (the parking
        -- board, id 278, which holds no stock) collected demand for boards
        -- that do.
        LEFT JOIN (SELECT ${EFF_BOARD_ID} mid, SUM(COALESCE(ol.parent_sheets_required, ol.sheets_required)) q FROM order_lines ol
                   JOIN products p ON p.id=ol.product_id WHERE ol.status IN ('planned','ready') GROUP BY ${EFF_BOARD_ID}) dm ON dm.mid=m.id
        WHERE COALESCE(av.q,0) < COALESCE(dm.q,0) OR COALESCE(av.q,0) < m.reorder_level) s`),

      one(`
      SELECT COUNT(*)::int AS lines, COALESCE(SUM((ol.qty-ol.dispatched_qty)*ol.rate),0) AS value
      FROM order_lines ol WHERE ol.status='produced'`),

      one(`
      SELECT COUNT(*)::int AS total,
        COALESCE(SUM(CASE WHEN (d.dispatched_at AT TIME ZONE 'Asia/Kolkata')::date
                               <= o.delivery_date::date THEN 1 ELSE 0 END),0)::int AS ontime
      FROM dispatches d JOIN orders o ON o.id=d.order_id
      WHERE o.delivery_date IS NOT NULL
        AND d.dispatched_at >= $1 AND d.dispatched_at < $2`, [mon.start, mon.end]),

      one(`
      SELECT COALESCE(SUM(dl.qty*ol.rate),0) AS value FROM dispatch_lines dl
      JOIN dispatches d ON d.id=dl.dispatch_id
      JOIN order_lines ol ON ol.id=dl.order_line_id
      WHERE d.dispatched_at >= $1 AND d.dispatched_at < $2`, [mon.start, mon.end]),

      q(`
      SELECT m.id, m.name, m.type, m.status,
        (SELECT COUNT(*)::int FROM job_cards jc WHERE jc.machine_id=m.id AND jc.status IN ('open','in_progress')) AS active_jobs
      FROM machines m ORDER BY m.type, m.name`),

      q(`
      SELECT ol.id, p.name AS product_name, o.po_number,
        COALESCE(ol.parent_sheets_required, ol.sheets_required) AS sheets_required,
        m.name AS board_name, COALESCE(av.q,0) AS available
      FROM order_lines ol
      JOIN products p ON p.id=ol.product_id
      -- The board this line will ACTUALLY run on: a warehouse pick made in the
      -- planning engine beats the product master (EFF_BOARD_ID's own rule).
      -- Keyed on the master alone this alert read the WRONG board's shelf —
      -- lines 263 and 267 sit on 'Unspecified board' (id 278, no stock) in the
      -- master while really running on FBB 280 20x38, so the plant was told
      -- "Unspecified board, 0 available" for a board with 800 on the rack.
      JOIN materials m ON m.id = ${EFF_BOARD_ID}
      JOIN orders o ON o.id=ol.order_id
      LEFT JOIN (SELECT material_id, SUM(qty) q FROM stock_batches WHERE status='available' GROUP BY material_id) av ON av.material_id = ${EFF_BOARD_ID}
      -- Multi-board: this is a THIRD independent shortfall gate, beside
      -- readiness() and production.js's JC_VIEW — none of them call each
      -- other. A job whose planned board alone is short but whose mix
      -- covers it in full must not raise a plant-wide shortage alert.
      -- bmp (board-mix position) — the shared BY-LINE spelling (helpers.js).
      -- A ganged line's board question belongs to its RUN, so the run's anchor
      -- answers it once for the whole run and the other members return n = 0
      -- and fall through to the ELSE arm below, exactly as they did before.
      -- With no mix rows bmp.n is 0 and that ELSE arm is character-identical
      -- to the pre-mix expression, so an unmixed job is flagged as it always
      -- was.
      ${BOARD_MIX_POSITION_BY_LINE_LATERAL}
      WHERE ol.status IN ('planned','ready')
        AND CASE WHEN bmp.n > 0 THEN bmp.short > 0
                 ELSE COALESCE(av.q,0) < COALESCE(ol.parent_sheets_required, ol.sheets_required) END
      LIMIT 5`),

      q(`
      SELECT x.xs_number, x.qty, x.stage, x.status, jc.jc_number
      FROM extra_sheet_requests x JOIN job_cards jc ON jc.id=x.job_card_id
      WHERE x.status IN ('pending','approved','sent_to_cutting','cutting_in_progress','cutting_completed','ready_for_printing')
      ORDER BY x.id LIMIT 5`),

      q(`
      SELECT o.po_number, c.name AS customer_name, o.delivery_date
      FROM orders o JOIN customers c ON c.id=o.customer_id
      WHERE o.status='open' AND o.delivery_date <= $1
      ORDER BY o.delivery_date LIMIT 5`, [plantDateStr(new Date(), 3)]),

      one(`SELECT COUNT(*)::int AS n FROM order_lines WHERE status='planned' AND artwork_locked=0`),

      // ── MES wiring ──────────────────────────────────────────────────────────
      // Bottleneck: which section holds the most work-in-progress right now.
      q(`
      SELECT js.stage, COUNT(*)::int AS wip
      FROM job_stages js JOIN job_cards jc ON jc.id=js.job_card_id
      WHERE jc.status IN ('open','in_progress') AND js.status IN ('pending','in_progress','partially_completed','hold')
      GROUP BY js.stage ORDER BY wip DESC`),

      // Machine utilisation today: stage-runs and output vs capacity per machine.
      q(`
      SELECT m.id, m.name, m.type, m.capacity_per_hour,
        COALESCE(t.runs, 0) AS runs_today, COALESCE(t.output, 0) AS output_today
      FROM machines m
      LEFT JOIN (
        SELECT js.machine_id, COUNT(*)::int AS runs, COALESCE(SUM(js.qty_out),0)::int AS output
        FROM job_stages js
        WHERE js.completed_at >= $1 AND js.completed_at < $2 AND js.machine_id IS NOT NULL
        GROUP BY js.machine_id
      ) t ON t.machine_id = m.id
      ORDER BY output_today DESC, m.type, m.name`, [day.start, day.end]),

      // Operator productivity today: completed runs + good output + wastage.
      q(`
      SELECT js.operator,
        COUNT(*)::int AS runs, COALESCE(SUM(js.qty_out),0)::int AS output,
        COALESCE(SUM(js.qty_scrap),0)::int AS wastage
      FROM job_stages js
      WHERE js.status='completed' AND js.operator IS NOT NULL
        AND js.completed_at >= $1 AND js.completed_at < $2
      GROUP BY js.operator ORDER BY output DESC LIMIT 8`, [day.start, day.end]),

      q(`
      SELECT jc.jc_number, jc.status, p.name AS product_name, c.name AS customer_name, jc.qty_planned,
        (SELECT stage FROM job_stages WHERE job_card_id=jc.id AND status IN ('in_progress','partially_completed') ORDER BY seq LIMIT 1) AS current_stage,
        (SELECT COUNT(*)::int FROM job_stages WHERE job_card_id=jc.id AND status='completed') AS done_stages,
        (SELECT COUNT(*)::int FROM job_stages WHERE job_card_id=jc.id) AS total_stages
      FROM job_cards jc JOIN products p ON p.id=jc.product_id
      JOIN order_lines ol ON ol.id=jc.order_line_id
      JOIN orders o ON o.id=ol.order_id JOIN customers c ON c.id=o.customer_id
      WHERE jc.status IN ('open','in_progress') ORDER BY jc.id DESC LIMIT 8`),
    ]);

    const alerts = [];
    for (const s of shortLines) {
      alerts.push({ type: 'shortage', text: `${s.board_name} short for ${s.product_name} (PO ${s.po_number}) — need ${s.sheets_required} parent sheets, have ${Math.round(s.available)}` });
    }
    // Extra sheet requests stuck in the control loop. Approval only grants
    // permission; Cutting still has to prepare and send the sheets to Printing.
    // These outrank due-date reminders: a machine is waiting on them right now.
    for (const x of xsOpen) {
      const xsStage = {
        pending: 'awaiting extra-sheet approval',
        approved: 'approved, awaiting Cutting',
        sent_to_cutting: 'sent to Cutting',
        cutting_in_progress: 'Cutting in progress',
        cutting_completed: 'Cutting completed, awaiting Printing transfer',
        ready_for_printing: 'ready for Printing transfer',
      }[x.status] || x.status.replaceAll('_', ' ');
      alerts.push({
        type: 'extra_sheet', to: '/extra-sheets',
        text: `${x.xs_number} — ${x.qty} extra sheets for ${x.jc_number} at ${x.stage.replace('_', ' ')} ${xsStage}`,
      });
    }
    for (const d of dueSoon) {
      alerts.push({ type: 'due', text: `PO ${d.po_number} (${d.customer_name}) due ${d.delivery_date}` });
    }
    if (awPending.n > 0) alerts.push({ type: 'artwork', text: `${awPending.n} line(s) waiting for artwork approval` });

    res.json({
      orders_in_hand: ordersInHand,
      wip_jobs: wip.jobs,
      wip_by_stage: wipByStage,
      produced_month: producedMonth.qty,
      closed_today: closedToday,
      scrap_pct: scrap.input > 0 ? +(100 * scrap.scrap / scrap.input).toFixed(1) : 0,
      shortages: shortages.n,
      ready_dispatch: readyDispatch,
      dispatched_month_value: dispatchedMonth.value,
      on_time_pct: onTime.total > 0 ? Math.round(100 * onTime.ontime / onTime.total) : null,
      machines, alerts, recent_jobs: recentJobs,
      bottleneck, machine_util: machineUtil, operator_prod: operatorProd,
    });
  } catch (e) { next(e); }
});

// ── Reports ─────────────────────────────────────────────────────────────────
r.get('/reports/production', async (req, res, next) => {
  try {
    const { from, to } = req.query;
    const range = plantRange(from, to);
    res.json(await q(`
      SELECT jc.jc_number, jc.closed_at, p.name AS product_name, c.name AS customer_name,
             jc.qty_planned, jc.qty_produced, jc.qty_scrap, jc.sheets_issued, m.name AS machine_name,
             ROUND(100.0*jc.qty_produced/NULLIF(jc.qty_planned,0),1) AS fulfilment_pct
      FROM job_cards jc
      JOIN products p ON p.id=jc.product_id
      JOIN order_lines ol ON ol.id=jc.order_line_id
      JOIN orders o ON o.id=ol.order_id JOIN customers c ON c.id=o.customer_id
      LEFT JOIN machines m ON m.id=jc.machine_id
      WHERE jc.status='closed'
        AND jc.closed_at >= $1 AND jc.closed_at < $2
      ORDER BY jc.closed_at DESC`, [range.start, range.end]));
  } catch (e) { next(e); }
});

r.get('/reports/scrap', async (_req, res, next) => {
  try {
    res.json(await q(`
      SELECT js.stage, COUNT(*)::int AS runs, SUM(js.qty_in)::int AS input, SUM(js.qty_scrap)::int AS scrap,
             ROUND(100.0*SUM(js.qty_scrap)/NULLIF(SUM(js.qty_in),0),2) AS scrap_pct
      FROM job_stages js WHERE js.status='completed'
      GROUP BY js.stage ORDER BY scrap_pct DESC NULLS LAST`));
  } catch (e) { next(e); }
});

r.get('/reports/sales', async (_req, res, next) => {
  try {
    res.json(await q(`
      SELECT c.name AS customer_name, c.segment,
             COUNT(DISTINCT o.id)::int AS orders,
             SUM(ol.qty*ol.rate) AS order_value,
             SUM(ol.dispatched_qty*ol.rate) AS dispatched_value,
             SUM((ol.qty-ol.dispatched_qty)*ol.rate) AS pending_value
      FROM order_lines ol
      JOIN orders o ON o.id=ol.order_id JOIN customers c ON c.id=o.customer_id
      WHERE ol.status != 'cancelled'
      GROUP BY c.id, c.name, c.segment ORDER BY order_value DESC`));
  } catch (e) { next(e); }
});

r.get('/reports/dispatch-register', async (_req, res, next) => {
  try {
    res.json(await q(`
      SELECT d.challan_number, d.dispatched_at, d.vehicle, c.name AS customer_name, o.po_number,
             SUM(dl.qty)::int AS total_qty, SUM(dl.qty*ol.rate) AS value
      FROM dispatches d
      JOIN customers c ON c.id=d.customer_id
      JOIN orders o ON o.id=d.order_id
      JOIN dispatch_lines dl ON dl.dispatch_id=d.id
      JOIN order_lines ol ON ol.id=dl.order_line_id
      GROUP BY d.id, d.challan_number, d.dispatched_at, d.vehicle, c.name, o.po_number
      ORDER BY d.id DESC`));
  } catch (e) { next(e); }
});

r.get('/reports/machine-load', async (_req, res, next) => {
  try {
    res.json(await q(`
      SELECT m.name, m.type, m.capacity_per_hour, m.status,
        COUNT(jc.id)::int AS jobs_30d, COALESCE(SUM(jc.qty_produced),0)::int AS produced_30d,
        COALESCE(SUM(jc.qty_scrap),0)::int AS scrap_30d
      FROM machines m
      LEFT JOIN job_cards jc ON jc.machine_id=m.id AND jc.closed_at >= now() - interval '30 days'
      GROUP BY m.id, m.name, m.type, m.capacity_per_hour, m.status
      ORDER BY m.type, m.name`));
  } catch (e) { next(e); }
});

// Wastage control — where the extra board actually went. Only ISSUED requests
// count (they are the sheets that left the warehouse); pending/rejected show
// up as discipline counters. extra_pct compares against the job's original
// issue (sheets_issued minus everything that came via extra requests).
r.get('/reports/extra-sheets', async (_req, res, next) => {
  try {
    const by_reason = await q(`
      SELECT reason, COUNT(*)::int AS requests, SUM(COALESCE(cutting_actual_qty, qty))::int AS sheets
      FROM extra_sheet_requests WHERE status='issued'
      GROUP BY reason ORDER BY sheets DESC`);
    const by_stage = await q(`
      SELECT stage, COUNT(*)::int AS requests, SUM(COALESCE(cutting_actual_qty, qty))::int AS sheets
      FROM extra_sheet_requests WHERE status='issued'
      GROUP BY stage ORDER BY sheets DESC`);
    const monthly = await q(`
      SELECT to_char(issued_at, 'YYYY-MM') AS month, COUNT(*)::int AS requests, SUM(COALESCE(cutting_actual_qty, qty))::int AS sheets
      FROM extra_sheet_requests WHERE status='issued'
      GROUP BY 1 ORDER BY 1 DESC LIMIT 12`);
    const discipline = await one(`
      SELECT COUNT(*) FILTER (WHERE status='issued')::int AS issued,
             COALESCE(SUM(COALESCE(cutting_actual_qty, qty)) FILTER (WHERE status='issued'),0)::int AS issued_sheets,
             COUNT(*) FILTER (WHERE status='rejected')::int AS rejected,
             COUNT(*) FILTER (WHERE status='cancelled')::int AS cancelled,
             COUNT(*) FILTER (WHERE status IN ('pending','approved','sent_to_cutting','cutting_in_progress','cutting_completed','ready_for_printing'))::int AS open
      FROM extra_sheet_requests`);
    const register = await q(`
      SELECT x.xs_number, x.issued_at, x.stage, COALESCE(x.cutting_actual_qty, x.qty) AS qty, x.reason, x.note,
             x.requested_by, x.approved_by, x.issued_by,
             jc.jc_number, jc.sheets_issued, p.name AS product_name, c.name AS customer_name,
             (jc.sheets_issued - jx.extra_total)::int AS original_issue,
             ROUND(100.0 * COALESCE(x.cutting_actual_qty, x.qty) / NULLIF(jc.sheets_issued - jx.extra_total, 0), 1) AS extra_pct
      FROM extra_sheet_requests x
      JOIN job_cards jc ON jc.id = x.job_card_id
      JOIN LATERAL (
        SELECT COALESCE(SUM(COALESCE(cutting_actual_qty, qty)),0)::int AS extra_total FROM extra_sheet_requests
        WHERE job_card_id = jc.id AND status='issued') jx ON true
      JOIN products p ON p.id = jc.product_id
      JOIN order_lines ol ON ol.id = jc.order_line_id
      JOIN orders o ON o.id = ol.order_id
      JOIN customers c ON c.id = o.customer_id
      WHERE x.status='issued'
      ORDER BY x.issued_at DESC LIMIT 300`);
    res.json({ by_reason, by_stage, monthly, discipline, register });
  } catch (e) { next(e); }
});

r.get('/audit', async (_req, res, next) => {
  try { res.json(await q('SELECT * FROM audit_log ORDER BY id DESC LIMIT 200')); } catch (e) { next(e); }
});

export default r;
