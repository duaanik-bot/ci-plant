// Dashboard KPIs + Reports. Live queries — no refresh buttons, no pivots.
import { Router } from 'express';
import { q, one } from '../db.js';

const r = Router();

r.get('/dashboard', async (_req, res, next) => {
  try {
    const month = new Date().toISOString().slice(0, 7);

    const ordersInHand = await one(`
      SELECT COUNT(*)::int AS lines, COALESCE(SUM((qty-dispatched_qty)*rate),0) AS value,
             COALESCE(SUM(qty-dispatched_qty),0)::int AS qty
      FROM order_lines WHERE status NOT IN ('dispatched','cancelled')`);

    const wip = await one(`SELECT COUNT(*)::int AS jobs FROM job_cards WHERE status IN ('open','in_progress')`);

    const wipByStage = await q(`
      SELECT js.stage, COUNT(*)::int AS n FROM job_stages js
      JOIN job_cards jc ON jc.id=js.job_card_id
      WHERE jc.status IN ('open','in_progress') AND js.status='in_progress'
      GROUP BY js.stage`);

    const closedToday = await one(`
      SELECT COUNT(*)::int AS jobs, COALESCE(SUM(qty_produced),0)::int AS cartons
      FROM job_cards WHERE status='closed' AND closed_at::date = current_date`);

    const producedMonth = await one(`
      SELECT COALESCE(SUM(qty_produced),0)::int AS qty FROM job_cards
      WHERE status='closed' AND to_char(closed_at,'YYYY-MM')=$1`, [month]);

    const scrap = await one(`
      SELECT COALESCE(SUM(js.qty_scrap),0)::int AS scrap, COALESCE(SUM(js.qty_in),0)::int AS input
      FROM job_stages js WHERE js.status='completed' AND to_char(js.completed_at,'YYYY-MM')=$1`, [month]);

    const shortages = await one(`
      SELECT COUNT(*)::int AS n FROM (
        SELECT m.id FROM materials m
        LEFT JOIN (SELECT material_id, SUM(qty) q FROM stock_batches WHERE status='available' GROUP BY material_id) av ON av.material_id=m.id
        LEFT JOIN (SELECT p.board_material_id mid, SUM(COALESCE(ol.parent_sheets_required, ol.sheets_required)) q FROM order_lines ol
                   JOIN products p ON p.id=ol.product_id WHERE ol.status IN ('planned','ready') GROUP BY p.board_material_id) dm ON dm.mid=m.id
        WHERE COALESCE(av.q,0) < COALESCE(dm.q,0) OR COALESCE(av.q,0) < m.reorder_level) s`);

    const readyDispatch = await one(`
      SELECT COUNT(*)::int AS lines, COALESCE(SUM((ol.qty-ol.dispatched_qty)*ol.rate),0) AS value
      FROM order_lines ol WHERE ol.status='produced'`);

    const onTime = await one(`
      SELECT COUNT(*)::int AS total,
        COALESCE(SUM(CASE WHEN d.dispatched_at::date <= o.delivery_date::date THEN 1 ELSE 0 END),0)::int AS ontime
      FROM dispatches d JOIN orders o ON o.id=d.order_id
      WHERE o.delivery_date IS NOT NULL AND to_char(d.dispatched_at,'YYYY-MM')=$1`, [month]);

    const dispatchedMonth = await one(`
      SELECT COALESCE(SUM(dl.qty*ol.rate),0) AS value FROM dispatch_lines dl
      JOIN dispatches d ON d.id=dl.dispatch_id
      JOIN order_lines ol ON ol.id=dl.order_line_id
      WHERE to_char(d.dispatched_at,'YYYY-MM')=$1`, [month]);

    const machines = await q(`
      SELECT m.id, m.name, m.type, m.status,
        (SELECT COUNT(*)::int FROM job_cards jc WHERE jc.machine_id=m.id AND jc.status IN ('open','in_progress')) AS active_jobs
      FROM machines m ORDER BY m.type, m.name`);

    const alerts = [];
    const shortLines = await q(`
      SELECT ol.id, p.name AS product_name, o.po_number,
        COALESCE(ol.parent_sheets_required, ol.sheets_required) AS sheets_required,
        m.name AS board_name, COALESCE(av.q,0) AS available
      FROM order_lines ol
      JOIN products p ON p.id=ol.product_id
      JOIN materials m ON m.id=p.board_material_id
      JOIN orders o ON o.id=ol.order_id
      LEFT JOIN (SELECT material_id, SUM(qty) q FROM stock_batches WHERE status='available' GROUP BY material_id) av ON av.material_id=p.board_material_id
      WHERE ol.status IN ('planned','ready') AND COALESCE(av.q,0) < COALESCE(ol.parent_sheets_required, ol.sheets_required)
      LIMIT 5`);
    for (const s of shortLines) {
      alerts.push({ type: 'shortage', text: `${s.board_name} short for ${s.product_name} (PO ${s.po_number}) — need ${s.sheets_required} parent sheets, have ${Math.round(s.available)}` });
    }
    const dueSoon = await q(`
      SELECT o.po_number, c.name AS customer_name, o.delivery_date
      FROM orders o JOIN customers c ON c.id=o.customer_id
      WHERE o.status='open' AND o.delivery_date <= to_char(current_date + 3, 'YYYY-MM-DD')
      ORDER BY o.delivery_date LIMIT 5`);
    for (const d of dueSoon) {
      alerts.push({ type: 'due', text: `PO ${d.po_number} (${d.customer_name}) due ${d.delivery_date}` });
    }
    const awPending = await one(`SELECT COUNT(*)::int AS n FROM order_lines WHERE status='planned' AND artwork_locked=0`);
    if (awPending.n > 0) alerts.push({ type: 'artwork', text: `${awPending.n} line(s) waiting for artwork approval` });

    // ── MES wiring ──────────────────────────────────────────────────────────
    // Bottleneck: which section holds the most work-in-progress right now.
    const bottleneck = await q(`
      SELECT js.stage, COUNT(*)::int AS wip
      FROM job_stages js JOIN job_cards jc ON jc.id=js.job_card_id
      WHERE jc.status IN ('open','in_progress') AND js.status IN ('pending','in_progress','hold')
      GROUP BY js.stage ORDER BY wip DESC`);

    // Machine utilisation today: stage-runs and output vs capacity per machine.
    const machineUtil = await q(`
      SELECT m.id, m.name, m.type, m.capacity_per_hour,
        (SELECT COUNT(*)::int FROM job_stages js WHERE js.machine_id=m.id AND js.completed_at::date=current_date) AS runs_today,
        (SELECT COALESCE(SUM(js.qty_out),0)::int FROM job_stages js WHERE js.machine_id=m.id AND js.completed_at::date=current_date) AS output_today
      FROM machines m ORDER BY output_today DESC, m.type, m.name`);

    // Operator productivity today: completed runs + good output + wastage.
    const operatorProd = await q(`
      SELECT js.operator,
        COUNT(*)::int AS runs, COALESCE(SUM(js.qty_out),0)::int AS output,
        COALESCE(SUM(js.qty_scrap),0)::int AS wastage
      FROM job_stages js
      WHERE js.status='completed' AND js.completed_at::date=current_date AND js.operator IS NOT NULL
      GROUP BY js.operator ORDER BY output DESC LIMIT 8`);

    const recentJobs = await q(`
      SELECT jc.jc_number, jc.status, p.name AS product_name, c.name AS customer_name, jc.qty_planned,
        (SELECT stage FROM job_stages WHERE job_card_id=jc.id AND status='in_progress' LIMIT 1) AS current_stage,
        (SELECT COUNT(*)::int FROM job_stages WHERE job_card_id=jc.id AND status='completed') AS done_stages,
        (SELECT COUNT(*)::int FROM job_stages WHERE job_card_id=jc.id) AS total_stages
      FROM job_cards jc JOIN products p ON p.id=jc.product_id
      JOIN order_lines ol ON ol.id=jc.order_line_id
      JOIN orders o ON o.id=ol.order_id JOIN customers c ON c.id=o.customer_id
      WHERE jc.status IN ('open','in_progress') ORDER BY jc.id DESC LIMIT 8`);

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
        AND jc.closed_at::date BETWEEN COALESCE($1::date, current_date - 30) AND COALESCE($2::date, current_date)
      ORDER BY jc.closed_at DESC`, [from || null, to || null]));
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

r.get('/audit', async (_req, res, next) => {
  try { res.json(await q('SELECT * FROM audit_log ORDER BY id DESC LIMIT 200')); } catch (e) { next(e); }
});

export default r;
