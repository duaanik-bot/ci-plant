// Live Floor + Track — the plant, section by section, and any product start→end.
//
// /floor      : every production section (printing → QC) with its queue:
//               running (in progress now), queued (arrived, ready to start),
//               incoming (still upstream — shows where it's waiting).
// /track      : searchable list of order lines with their live position.
// /track/:id  : full journey of one order line — SO → planning → artwork →
//               every stage with quantities/operators/timestamps → FG → challans.
import { Router } from 'express';
import { q, one } from '../db.js';

const r = Router();

// The CI-Production 10-section flow, in plant sequence.
export const SECTIONS = ['cutting', 'printing', 'coating', 'lamination', 'foiling', 'embossing', 'die_cutting', 'sorting', 'pasting', 'qc'];

r.get('/floor', async (_req, res, next) => {
  try {
    const stages = await q(`
      SELECT js.id, js.job_card_id, js.seq, js.stage, js.status, js.unit,
             js.qty_in, js.qty_out, js.qty_scrap, js.operator, js.started_at, js.hold_reason,
             jc.jc_number, jc.qty_planned, jc.sheets_issued, jc.queue_pos,
             p.name AS product_name, p.code AS product_code,
             c.name AS customer_name, o.po_number, o.delivery_date,
             COALESCE(sm.name, m.name) AS machine_name
      FROM job_stages js
      JOIN job_cards jc ON jc.id = js.job_card_id
      JOIN products p ON p.id = jc.product_id
      JOIN order_lines ol ON ol.id = jc.order_line_id
      JOIN orders o ON o.id = ol.order_id
      JOIN customers c ON c.id = o.customer_id
      LEFT JOIN machines m ON m.id = jc.machine_id
      LEFT JOIN machines sm ON sm.id = js.machine_id
      WHERE jc.status IN ('open','in_progress')
      ORDER BY jc.queue_pos NULLS LAST, o.delivery_date NULLS LAST, jc.id, js.seq`);

    const machines = await q('SELECT * FROM machines ORDER BY type, name');

    const byJc = {};
    for (const s of stages) (byJc[s.job_card_id] ||= []).push(s);

    const sections = Object.fromEntries(
      SECTIONS.map(s => [s, { section: s, running: [], held: [], queued: [], incoming: [] }]));

    for (const list of Object.values(byJc)) {
      list.sort((a, b) => a.seq - b.seq);
      const blockedBy = list.find(s => s.status === 'in_progress' || s.status === 'hold');
      const firstPending = list.find(s => s.status === 'pending');
      for (const s of list) {
        if (s.status === 'completed') continue;
        const prev = list.find(x => x.seq === s.seq - 1);
        const entry = {
          stage_id: s.id, job_card_id: s.job_card_id, jc_number: s.jc_number, seq: s.seq, stage: s.stage,
          product_name: s.product_name, product_code: s.product_code,
          customer_name: s.customer_name, po_number: s.po_number, delivery_date: s.delivery_date,
          unit: s.unit, qty_in: s.qty_in, qty_planned: s.qty_planned,
          expected_qty: s.qty_in ?? prev?.qty_out ?? s.sheets_issued,
          operator: s.operator, started_at: s.started_at, hold_reason: s.hold_reason,
          machine_name: s.machine_name, queue_pos: s.queue_pos, delivery_date: s.delivery_date,
          upstream: prev ? { stage: prev.stage, status: prev.status } : null,
        };
        if (s.status === 'in_progress') sections[s.stage].running.push(entry);
        else if (s.status === 'hold') sections[s.stage].held.push(entry);
        else if (!blockedBy && s === firstPending) sections[s.stage].queued.push(entry);
        else sections[s.stage].incoming.push(entry);
      }
    }

    // byJc iterates numeric keys ascending — restore the planned order:
    // print-planning queue_pos first, then delivery date.
    const laneSort = (a, b) => (a.queue_pos ?? 1e9) - (b.queue_pos ?? 1e9)
      || String(a.delivery_date ?? '9999').localeCompare(String(b.delivery_date ?? '9999'))
      || a.job_card_id - b.job_card_id;
    for (const sec of Object.values(sections)) {
      sec.running.sort(laneSort); sec.held.sort(laneSort);
      sec.queued.sort(laneSort); sec.incoming.sort(laneSort);
    }

    // Today's throughput per section — completed runs today.
    const todayStats = await q(`
      SELECT stage,
             COUNT(*)::int AS completed_today,
             COALESCE(SUM(qty_in),0)::int AS received_today,
             COALESCE(SUM(qty_out),0)::int AS produced_today,
             COALESCE(SUM(qty_scrap),0)::int AS scrap_today
      FROM job_stages
      WHERE status='completed' AND completed_at::date = current_date
      GROUP BY stage`);
    const statsByStage = Object.fromEntries(todayStats.map(t => [t.stage, t]));

    res.json(SECTIONS.map(s => ({
      ...sections[s],
      machines: machines.filter(m => m.type === s),
      today: statsByStage[s] || { completed_today: 0, received_today: 0, produced_today: 0, scrap_today: 0 },
    })));
  } catch (e) { next(e); }
});

// One section's full workspace: KPIs, live queue, completed runs, audit trail.
r.get('/floor/:section', async (req, res, next) => {
  try {
    const section = req.params.section;
    if (!SECTIONS.includes(section)) return res.status(404).json({ error: 'Unknown section' });

    const STAGE_VIEW = `
      SELECT js.*, jc.jc_number, jc.qty_planned, jc.sheets_issued, jc.queue_pos,
             p.name AS product_name, p.code AS product_code,
             c.name AS customer_name, o.po_number, o.delivery_date,
             COALESCE(sm.name, m.name) AS machine_name
      FROM job_stages js
      JOIN job_cards jc ON jc.id = js.job_card_id
      JOIN products p ON p.id = jc.product_id
      JOIN order_lines ol ON ol.id = jc.order_line_id
      JOIN orders o ON o.id = ol.order_id
      JOIN customers c ON c.id = o.customer_id
      LEFT JOIN machines m ON m.id = jc.machine_id
      LEFT JOIN machines sm ON sm.id = js.machine_id`;

    // Live queue for this section, with the same frontier logic as /floor.
    const open = await q(`${STAGE_VIEW} WHERE jc.status IN ('open','in_progress')
      ORDER BY jc.queue_pos NULLS LAST, o.delivery_date NULLS LAST, jc.id, js.seq`);
    const byJc = {};
    for (const s of open) (byJc[s.job_card_id] ||= []).push(s);
    const queue = [];
    for (const list of Object.values(byJc)) {
      list.sort((a, b) => a.seq - b.seq);
      const blockedBy = list.find(s => s.status === 'in_progress' || s.status === 'hold');
      const firstPending = list.find(s => s.status === 'pending');
      for (const s of list) {
        if (s.stage !== section || s.status === 'completed') continue;
        const prev = list.find(x => x.seq === s.seq - 1);
        queue.push({
          ...s,
          expected_qty: s.qty_in ?? prev?.qty_out ?? s.sheets_issued,
          queue_state: s.status === 'in_progress' ? 'running'
            : s.status === 'hold' ? 'hold'
            : (!blockedBy && s === firstPending) ? 'queued' : 'incoming',
          upstream: prev ? { stage: prev.stage, status: prev.status } : null,
        });
      }
    }
    queue.sort((a, b) => (a.queue_pos ?? 1e9) - (b.queue_pos ?? 1e9)
      || String(a.delivery_date ?? '9999').localeCompare(String(b.delivery_date ?? '9999'))
      || a.job_card_id - b.job_card_id);

    // Completed runs at this section (most recent first), yield per run.
    const completed = (await q(`${STAGE_VIEW}
      WHERE js.stage=$1 AND js.status='completed'
      ORDER BY js.completed_at DESC LIMIT 200`, [section]))
      .map(s => ({
        ...s,
        yield_pct: s.qty_in > 0 ? +(100 * s.qty_out / s.qty_in).toFixed(1) : null,
        wastage_pct: s.qty_in > 0 ? +(100 * s.qty_scrap / s.qty_in).toFixed(1) : null,
        duration_min: s.started_at && s.completed_at
          ? Math.round((new Date(s.completed_at) - new Date(s.started_at)) / 60000) : null,
      }));

    // Section KPIs
    const today = completed.filter(s => new Date(s.completed_at).toDateString() === new Date().toDateString());
    const sum = (rows, k) => rows.reduce((a, r) => a + (r[k] || 0), 0);
    const kpis = {
      pending: queue.filter(s => s.queue_state === 'queued').length,
      incoming: queue.filter(s => s.queue_state === 'incoming').length,
      running: queue.filter(s => s.queue_state === 'running').length,
      on_hold: queue.filter(s => s.queue_state === 'hold').length,
      completed_today: today.length,
      received_today: sum(today, 'qty_in'),
      produced_today: sum(today, 'qty_out'),
      scrap_today: sum(today, 'qty_scrap'),
      yield_today: sum(today, 'qty_in') > 0 ? +(100 * sum(today, 'qty_out') / sum(today, 'qty_in')).toFixed(1) : null,
      received_all: sum(completed, 'qty_in'),
      produced_all: sum(completed, 'qty_out'),
      scrap_all: sum(completed, 'qty_scrap'),
      yield_all: sum(completed, 'qty_in') > 0 ? +(100 * sum(completed, 'qty_out') / sum(completed, 'qty_in')).toFixed(1) : null,
    };

    // Audit trail for stages of this section.
    const audit = await q(`
      SELECT al.*, js.stage, jc.jc_number
      FROM audit_log al
      JOIN job_stages js ON js.id = al.entity_id
      JOIN job_cards jc ON jc.id = js.job_card_id
      WHERE al.entity='job_stage' AND js.stage=$1
      ORDER BY al.id DESC LIMIT 100`, [section]);

    const machines = await q(`SELECT * FROM machines WHERE type=$1 ORDER BY name`, [section]);

    res.json({ section, kpis, queue, completed, audit, machines });
  } catch (e) { next(e); }
});

// ── Track ───────────────────────────────────────────────────────────────────
r.get('/track', async (_req, res, next) => {
  try {
    res.json(await q(`
      SELECT ol.id, ol.qty, ol.dispatched_qty, ol.status, ol.planned_date,
             o.po_number, o.delivery_date, c.name AS customer_name,
             p.name AS product_name, p.code AS product_code,
             jc.jc_number,
             (SELECT stage FROM job_stages WHERE job_card_id=jc.id AND status='in_progress' LIMIT 1) AS current_stage,
             (SELECT stage FROM job_stages WHERE job_card_id=jc.id AND status='pending' ORDER BY seq LIMIT 1) AS next_stage,
             (SELECT COUNT(*)::int FROM job_stages WHERE job_card_id=jc.id AND status='completed') AS done_stages,
             (SELECT COUNT(*)::int FROM job_stages WHERE job_card_id=jc.id) AS total_stages
      FROM order_lines ol
      JOIN orders o ON o.id = ol.order_id
      JOIN customers c ON c.id = o.customer_id
      JOIN products p ON p.id = ol.product_id
      LEFT JOIN job_cards jc ON jc.order_line_id = ol.id
      WHERE ol.status != 'cancelled'
      ORDER BY (ol.status='dispatched'), o.delivery_date NULLS LAST, ol.id DESC`));
  } catch (e) { next(e); }
});

r.get('/track/:id', async (req, res, next) => {
  try {
    const line = await one(`
      SELECT ol.*, o.po_number, o.po_date, o.delivery_date, o.created_at AS order_created_at,
             o.status AS order_status, c.name AS customer_name, c.city,
             p.name AS product_name, p.code AS product_code, p.size, p.colors, p.coating, p.special, p.ups,
             bm.name AS board_name, m.name AS machine_name
      FROM order_lines ol
      JOIN orders o ON o.id = ol.order_id
      JOIN customers c ON c.id = o.customer_id
      JOIN products p ON p.id = ol.product_id
      JOIN materials bm ON bm.id = p.board_material_id
      LEFT JOIN machines m ON m.id = ol.machine_id
      WHERE ol.id = $1`, [req.params.id]);
    if (!line) return res.status(404).json({ error: 'Order line not found' });

    const jc = await one('SELECT * FROM job_cards WHERE order_line_id=$1', [line.id]);
    const stages = jc
      ? await q('SELECT * FROM job_stages WHERE job_card_id=$1 ORDER BY seq', [jc.id])
      : [];
    const issues = jc
      ? await q(`SELECT sm.*, b.batch_no FROM stock_movements sm
                 LEFT JOIN stock_batches b ON b.id = sm.batch_id
                 WHERE sm.ref_type='job_card' AND sm.ref_id=$1 AND sm.type='consumption'
                 ORDER BY sm.id`, [jc.id])
      : [];
    const challans = await q(`
      SELECT d.challan_number, d.vehicle, d.driver, d.dispatched_at, d.id AS dispatch_id, dl.qty
      FROM dispatch_lines dl JOIN dispatches d ON d.id = dl.dispatch_id
      WHERE dl.order_line_id = $1 ORDER BY d.id`, [line.id]);
    const trail = await q(`
      SELECT * FROM audit_log WHERE entity='order_line' AND entity_id=$1 ORDER BY id`, [line.id]);

    // Assemble the timeline. Every event: { key, title, detail, at, state }
    const events = [];
    events.push({
      key: 'order', title: 'Sales order received',
      detail: `PO ${line.po_number} — ${line.customer_name} · ${line.qty.toLocaleString('en-IN')} cartons`,
      at: line.order_created_at, state: 'done',
    });

    const plannedAudit = trail.find(t => t.action === 'planned');
    events.push({
      key: 'planned', title: 'Planned',
      detail: line.machine_id
        ? `${line.machine_name} · ${line.planned_date} · ${(line.sheets_required ?? 0).toLocaleString('en-IN')} sheets (${line.board_name})`
        : 'Waiting for machine + date',
      at: plannedAudit?.created_at ?? null, by: plannedAudit?.user_name,
      state: line.machine_id ? 'done' : 'todo',
    });

    const artAudit = trail.filter(t => t.action === 'artwork_locked').pop();
    events.push({
      key: 'artwork', title: 'Artwork approved & locked',
      detail: line.artwork_locked ? 'Customer ✓ and QA ✓ — locked for print'
        : `${line.artwork_customer_ok ? 'Customer ✓' : 'Customer pending'} · ${line.artwork_qa_ok ? 'QA ✓' : 'QA pending'}`,
      at: artAudit?.created_at ?? null, by: artAudit?.user_name,
      state: line.artwork_locked ? 'done' : 'todo',
    });

    if (jc) {
      events.push({
        key: 'jobcard', title: `Job card ${jc.jc_number} released`,
        detail: `${jc.sheets_issued.toLocaleString('en-IN')} sheets issued${issues.length ? ` — batch ${issues.map(i => i.batch_no).filter(Boolean).join(', ')}` : ''}`,
        at: jc.created_at, state: 'done',
      });
      for (const st of stages) {
        events.push({
          key: `stage-${st.id}`, title: st.stage === 'qc' ? 'QC' : st.stage.replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase()),
          stage: st.stage,
          detail: st.status === 'completed'
            ? `${(st.qty_in ?? 0).toLocaleString('en-IN')} in → ${(st.qty_out ?? 0).toLocaleString('en-IN')} out · ${st.qty_scrap.toLocaleString('en-IN')} scrap ${st.unit}${st.operator ? ` · ${st.operator}` : ''}`
            : st.status === 'in_progress'
              ? `Running now — ${(st.qty_in ?? 0).toLocaleString('en-IN')} ${st.unit} in${st.operator ? ` · ${st.operator}` : ''}`
              : 'Waiting in queue',
          at: st.completed_at ?? st.started_at ?? null,
          state: st.status === 'completed' ? 'done' : st.status === 'in_progress' ? 'active' : 'todo',
        });
      }
      events.push({
        key: 'fg', title: 'Finished goods to warehouse',
        detail: jc.status === 'closed' ? `${jc.qty_produced.toLocaleString('en-IN')} cartons in · ${jc.qty_scrap.toLocaleString('en-IN')} total scrap` : 'After final QC',
        at: jc.closed_at, state: jc.status === 'closed' ? 'done' : 'todo',
      });
    } else {
      events.push({ key: 'jobcard', title: 'Job card', detail: 'Released once all three gates are green', at: null, state: 'todo' });
      events.push({ key: 'fg', title: 'Finished goods to warehouse', detail: 'After production', at: null, state: 'todo' });
    }

    for (const ch of challans) {
      events.push({
        key: `challan-${ch.dispatch_id}`, title: `Dispatched — ${ch.challan_number}`,
        detail: `${ch.qty.toLocaleString('en-IN')} cartons${ch.vehicle ? ` · ${ch.vehicle}` : ''}${ch.driver ? ` · ${ch.driver}` : ''}`,
        at: ch.dispatched_at, state: 'done', dispatch_id: ch.dispatch_id,
      });
    }
    if (line.status !== 'dispatched') {
      events.push({
        key: 'dispatch', title: 'Dispatch complete',
        detail: `${line.dispatched_qty.toLocaleString('en-IN')} of ${line.qty.toLocaleString('en-IN')} cartons sent`,
        at: null, state: 'todo',
      });
    }

    res.json({ line, job_card: jc, events });
  } catch (e) { next(e); }
});

export default r;
