// Live Floor + Track — the plant, section by section, and any product start→end.
//
// /floor      : every production section (printing → QC) with its queue:
//               running (in progress now), queued (arrived, ready to start),
//               incoming (still upstream — shows where it's waiting).
// /track      : searchable list of order lines with their live position.
// /track/:id  : full journey of one order line — SO → planning → artwork →
//               every stage with quantities/operators/timestamps → FG → challans.
import { Router } from 'express';
import { q, one, tx } from '../db.js';
import { requireRole, floorScope } from '../auth.js';
import { audit, readiness, readinessBatch } from '../helpers.js';
import { receiptFor, previousOf } from '../stage-runs.js';
import { readinessLight, lightForJobCards } from '../readiness-light.js';
import { toolingDetail, toolingGateOk } from '../tooling-gate.js';
import { orderBoard, byState, moveWithin, splitByMachine } from '../floor-order.js';

const r = Router();
const canRun = requireRole('production'); // admin implied

// The CI-Production 10-section flow, in plant sequence.
export const SECTIONS = ['cutting', 'printing', 'coating', 'lamination', 'foiling', 'embossing', 'die_cutting', 'sorting', 'pasting', 'qc'];

// A printing stage's effective press: the machine it started on, else the press
// pinned from Print Planning. Used to scope press-operator logins to their queue.
const effectiveMachineId = row => row.machine_id ?? row.press_machine_id ?? null;

// Machine-category order for the control board — same flow, but with prepress
// (CTP plate-making) in its plant slot right after cutting. CTP is equipment,
// not a routed production section, so it lives here rather than in SECTIONS.
const MACHINE_TYPE_ORDER = ['cutting', 'ctp', 'printing', 'coating', 'lamination', 'foiling', 'embossing', 'die_cutting', 'sorting', 'pasting'];
const machineTypeRank = t => { const i = MACHINE_TYPE_ORDER.indexOf(t); return i === -1 ? MACHINE_TYPE_ORDER.length : i; };

// Frontier classification, shared by /floor, the machine board and
// /sections/:section so the three boards never diverge.
//
// Concurrency is allowed: a product is usually printed, coated and finished
// inline in one pass, so EVERY pending stage can be started — even ahead of an
// unfinished upstream stage. Upstream ordering is enforced at COMPLETION
// (production.js), not here. States:
//   running  — in progress now
//   partial  — day-wise counts recorded, more to come (stage_runs on the stage)
//   hold     — paused
//   queued   — pending and ready in the normal flow (upstream already done)
//   incoming — pending but ahead of an unfinished upstream stage (still startable)
// `startable` is the single source of truth the Start button keys off: any
// pending stage qualifies.
const frontierState = (s, prev) =>
  s.status === 'in_progress' ? 'running'
    : s.status === 'partially_completed' ? 'partial'
    : s.status === 'hold' ? 'hold'
    : (!prev || prev.status === 'completed') ? 'queued' : 'incoming';

const prevStageOf = previousOf;

// The queue-row twin of stageReceipt() in helpers.js: what this station has
// received, in its own unit — computed from rows already fetched, so a board
// needn't fire a query a job. Same pure receiptFor() the rest of the server
// uses, so the two can't drift.
//
// Boards used to show `qty_in ?? prev.qty_out`, and qty_in is a snapshot taken
// when the stage started. Upstream keeps counting, the snapshot does not, and
// the station ends up shown a received figure that matches neither its upstream
// nor the ceiling the server enforces when it saves. Derive, don't cache.
const rowReceipt = (s, prev) => {
  const { upstream_available, extra_issued, received } = receiptFor({
    stage: s, prev, ups: s.ups,
    childrenPerParent: s.children_per_parent,
    extraParents: s.extra_issued_parents,
  });
  return { upstream_available, extra_issued, received };
};

// Extra sheets issued straight to a stage, in PARENT sheets — the unit CI-XS
// requests in. rowReceipt converts to the stage's own counting unit.
const XS_ISSUED_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(qty),0)::int AS qty
    FROM extra_sheet_requests WHERE job_stage_id = js.id AND status='issued') xsq ON true`;

// Gang member roll-up — one JSON array per gang PARENT card (order_line_id is
// NULL) with every bound product, qty and PO, so a station can render the whole
// gang as ONE unified row. Solo cards and split children get NULL.
const GANG_MEMBERS_LATERAL = `
  LEFT JOIN gang_runs gg ON gg.id = jc.gang_run_id
  LEFT JOIN LATERAL (
    SELECT json_agg(json_build_object(
             'line_id', ol3.id, 'product_id', p3.id,
             'product_name', p3.name, 'product_code', p3.code,
             'qty', ol3.qty, 'po_number', o3.po_number, 'customer_name', c3.name,
             'delivery_date', o3.delivery_date,
             'output_number', COALESCE(ol3.spec_override->>'output_number', p3.output_number),
             'sheets_required', ol3.sheets_required,
             'parent_sheets_required', ol3.parent_sheets_required
           ) ORDER BY ol3.id) AS members
    FROM order_lines ol3
    JOIN orders o3 ON o3.id = ol3.order_id
    JOIN customers c3 ON c3.id = o3.customer_id
    JOIN products p3 ON p3.id = ol3.product_id
    WHERE ol3.gang_run_id = jc.gang_run_id
  ) gm ON jc.order_line_id IS NULL AND jc.gang_run_id IS NOT NULL
  LEFT JOIN LATERAL (
    -- A COMBINED RUN keeps its EARLIEST promise: queue priority is the soonest
    -- delivery across every sales order on the pile, not the anchor member's
    -- (gol is the LOWEST-ID line, which may be the latest PO). Scoped to
    -- kind='merge' so every gang sorts exactly as it does today.
    SELECT MIN(o5.delivery_date) AS min_delivery
    FROM order_lines ol5 JOIN orders o5 ON o5.id = ol5.order_id
    WHERE ol5.gang_run_id = jc.gang_run_id
  ) runagg ON jc.order_line_id IS NULL AND gg.kind = 'merge'`;

// Full per-stage row with product / customer / machine / operator context —
// shared by the single-section workspace and the combined Sort & Paste station.
// Gang parent cards have no order line of their own: the anchor line (gol)
// supplies order context and gm carries every member for the unified row.
const STAGE_VIEW = `
  SELECT js.*, jc.jc_number, jc.order_line_id, jc.qty_planned, jc.sheets_issued, jc.queue_pos, jc.children_per_parent,
         jc.machine_id AS press_machine_id,
         -- The line that carries this card's order context: its own, or (for a
         -- gang parent, which has none) the gang's anchor. /floor selects the
         -- same expression; the readiness gates are keyed on it, so without it
         -- here the section workspace could not compute a light at all.
         COALESCE(ol.id, gol.id) AS anchor_line_id,
         jc.product_id, jc.machine_id AS card_machine_id, jc.finalised_at,
         jc.ready_override, jc.ready_override_by, jc.ready_override_at, jc.ready_override_reason,
         jc.gang_run_id, gg.gang_number, gg.kind AS run_kind, gm.members AS gang_members,
         p.name AS product_name, p.code AS product_code,
         -- Output number = the product master's print-set number (the plate no.
         -- the floor calls a job by), the job's own override winning — the same
         -- value Planning and Artwork edit. The plate tool's separate output_no
         -- is NOT this. Queue rows print it beside the job card number, and
         -- rowMatches() then makes the whole queue searchable by it for free.
         -- A GANG names itself: its mixed-product layout is plated for that run
         -- alone, so the run's own number wins over any master here too, and
         -- every station sees the same number the planner typed. Combined runs
         -- print one product from its own plate and keep the master's.
         COALESCE(CASE WHEN gg.kind = 'gang' THEN NULLIF(gg.output_number, '') END,
                  COALESCE(ol.spec_override, gol.spec_override)->>'output_number', p.output_number) AS output_number,
         CASE WHEN gg.kind = 'gang' THEN NULLIF(gg.output_number, '') END AS run_output_number,
         p.colors, p.coating, p.special, p.ups, p.size, p.gsm, p.pasting_type,
         -- Finalised (effective) child + parent from planning: the order line's
         -- spec_override wins over the product master, so the station shows the
         -- board & child the planner actually locked.
         COALESCE((COALESCE(ol.spec_override, gol.spec_override)->>'child_l')::float, p.child_l) AS child_l,
         COALESCE((COALESCE(ol.spec_override, gol.spec_override)->>'child_w')::float, p.child_w) AS child_w,
         COALESCE(ebm.name, bm.name) AS board_name,
         COALESCE(ebm.sheet_l, bm.sheet_l) AS sheet_l, COALESCE(ebm.sheet_w, bm.sheet_w) AS sheet_w,
         -- Board is stored and issued in PACKETS, so a station screen naming a
         -- sheet count carries its packet equivalent beside it.
         COALESCE(ebm.sheets_per_packet, bm.sheets_per_packet) AS sheets_per_packet,
         COALESCE(NULLIF(p.board_grade,''), NULLIF(split_part(p.board_name,' ',1),''), split_part(COALESCE(ebm.name, bm.name),' ',1)) AS board_grade,
         -- Die number, in the same order the job-card register resolves it: the
         -- gang's own die (a mixed layout is cut by a die made for that run),
         -- then the job/master die text, then the Tooling Hub code. Die Cutting
         -- reads this column, and it used to see ONLY the hub code — a run
         -- whose die was named in Planning showed nothing at the one station
         -- that needs it.
         COALESCE(CASE WHEN gg.kind = 'gang' THEN NULLIF(gg.die_number, '') END,
                  COALESCE(ol.spec_override, gol.spec_override)->>'die_number',
                  NULLIF(p.die_number, ''), dd.code) AS die_number,
         dd.location AS die_location,
         c.name AS customer_name, o.po_number,
         COALESCE(runagg.min_delivery, o.delivery_date) AS delivery_date,
         COALESCE(sm.name, m.name) AS machine_name,
         COALESCE(sm.model, m.model) AS machine_model,
         COALESCE(js.operator, mcrew.name) AS operator,
         COALESCE(xsq.qty, 0) AS extra_issued_parents
  FROM job_stages js
  JOIN job_cards jc ON jc.id = js.job_card_id
  JOIN products p ON p.id = jc.product_id
  JOIN materials bm ON bm.id = p.board_material_id
  LEFT JOIN tools dd ON dd.id = p.tool_id
  LEFT JOIN order_lines ol ON ol.id = jc.order_line_id
  LEFT JOIN LATERAL (
    SELECT ol2.* FROM order_lines ol2
    WHERE ol2.gang_run_id = jc.gang_run_id
    ORDER BY ol2.id LIMIT 1
  ) gol ON jc.order_line_id IS NULL
  LEFT JOIN materials ebm ON ebm.id = COALESCE((COALESCE(ol.spec_override, gol.spec_override)->>'board_material_id')::int, p.board_material_id)
  JOIN orders o ON o.id = COALESCE(ol.order_id, gol.order_id)
  JOIN customers c ON c.id = o.customer_id
  ${GANG_MEMBERS_LATERAL}
  LEFT JOIN machines m ON m.id = jc.machine_id
  LEFT JOIN machines sm ON sm.id = js.machine_id
  LEFT JOIN LATERAL (
    SELECT e.name FROM machine_operators mo JOIN employees e ON e.id = mo.employee_id
    WHERE mo.machine_id = COALESCE(js.machine_id, jc.machine_id) AND e.active = 1
    ORDER BY e.name LIMIT 1) mcrew ON true
  ${XS_ISSUED_LATERAL}`;

r.get('/floor', async (req, res, next) => {
  try {
    const stages = await q(`
      SELECT js.id, js.job_card_id, js.seq, js.stage, js.status, js.unit,
             js.qty_in, js.qty_out, js.qty_scrap, js.operator, js.started_at, js.hold_reason, js.floor_pos,
             -- The card's OWN order line, NULL for a gang card — the board-issue
             -- gate (Floor.jsx) needs exactly this, never anchor_line_id below:
             -- anchor_line_id falls back to the gang's lead member (gol.id) so a
             -- gang parent would read as "has an order line" and wrongly qualify
             -- for a feature gangs are excluded from by design.
             jc.jc_number, jc.order_line_id, jc.qty_planned, jc.sheets_issued, jc.queue_pos, jc.children_per_parent,
             jc.gang_run_id, gg.gang_number, gg.kind AS run_kind, gm.members AS gang_members,
             jc.product_id, jc.machine_id AS card_machine_id, jc.finalised_at,
             jc.ready_override, jc.ready_override_by, jc.ready_override_at, jc.ready_override_reason,
             -- Anchor line: the card's own order line, or the gang's lead
             -- member for a parent card — the row readiness() takes.
             COALESCE(ol.id, gol.id) AS anchor_line_id,
             p.name AS product_name, p.code AS product_code,
             c.name AS customer_name, o.po_number,
             COALESCE(runagg.min_delivery, o.delivery_date) AS delivery_date,
             COALESCE(sm.name, m.name) AS machine_name,
             COALESCE(sm.id, m.id) AS machine_id,
             -- Mix-aware, the same CASE as JC_VIEW and /print-planning: a job
             -- the engine covered across several boards checks each mix row
             -- against ITS OWN board's stock — the cutting station must not
             -- flag "board short" on a job the engine already covered.
             (NOT EXISTS (SELECT 1 FROM stock_movements smv
                          WHERE smv.ref_type='job_card' AND smv.ref_id=jc.id AND smv.type='consumption')
              AND CASE WHEN bmp.n > 0 THEN bmp.short > 0 ELSE stk.avail < jc.sheets_issued END) AS board_pending,
             oxs.xs_number AS open_xs
      FROM job_stages js
      JOIN job_cards jc ON jc.id = js.job_card_id
      JOIN products p ON p.id = jc.product_id
      LEFT JOIN order_lines ol ON ol.id = jc.order_line_id
      LEFT JOIN LATERAL (
        SELECT ol2.* FROM order_lines ol2
        WHERE ol2.gang_run_id = jc.gang_run_id
        ORDER BY ol2.id LIMIT 1
      ) gol ON jc.order_line_id IS NULL
      JOIN orders o ON o.id = COALESCE(ol.order_id, gol.order_id)
      JOIN customers c ON c.id = o.customer_id
      ${GANG_MEMBERS_LATERAL}
      LEFT JOIN machines m ON m.id = jc.machine_id
      LEFT JOIN machines sm ON sm.id = js.machine_id
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(sb.qty),0) AS avail FROM stock_batches sb
        WHERE sb.material_id = COALESCE((COALESCE(ol.spec_override, gol.spec_override)->>'board_material_id')::int, p.board_material_id)
          AND sb.status='available'
      ) stk ON true
      -- bmp = board-mix position, verbatim from JC_VIEW: keyed on the card's
      -- OWN order line (NULL for gang cards, so they fall through to the
      -- single-board arm — gangs are excluded from mixes by design).
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS n,
               COALESCE(SUM(GREATEST(0, x.sheets - COALESCE(sa.q,0))), 0) AS short
        FROM job_board_mix x
        LEFT JOIN (SELECT material_id, SUM(qty) AS q FROM stock_batches
                   WHERE status='available' GROUP BY material_id) sa ON sa.material_id = x.material_id
        WHERE x.order_line_id = jc.order_line_id AND x.phase='plan'
      ) bmp ON true
      -- An extra-sheet request already awaiting decision on this job card. The
      -- board hides its ⊞ control when one is open, because the server allows
      -- only one at a time and would otherwise 409 the operator.
      LEFT JOIN LATERAL (
        SELECT xs_number FROM extra_sheet_requests
        WHERE job_card_id = jc.id AND status IN ('pending','approved') LIMIT 1) oxs ON true
      WHERE jc.status IN ('open','in_progress')
      ORDER BY jc.queue_pos NULLS LAST, o.delivery_date NULLS LAST, jc.id, js.seq`);

    // Active machines only — a decommissioned press must not come back as a
    // controllable row inside its band (the old Machine Control grid filtered
    // this list; the bands render it).
    const machines = await q('SELECT * FROM machines WHERE COALESCE(active,1)=1 ORDER BY type, name');

    const byJc = {};
    for (const s of stages) (byJc[s.job_card_id] ||= []).push(s);

    // One traffic light per job CARD, worn by every stage row of that card — an
    // operator at pasting reads the same dot the press does. It runs over
    // readiness()'s gates, the SAME facts the release gate uses, so the floor
    // and Planning cannot hold two opinions. Everything is batched: the board
    // carries every open job in the plant, and a query per row would make it
    // slower the busier the plant gets.
    const cardRows = Object.values(byJc).map(list => list[0]);
    const anchorIds = [...new Set(cardRows.map(s => s.anchor_line_id).filter(x => x != null))];
    const anchors = anchorIds.length
      ? await q('SELECT * FROM order_lines WHERE id = ANY($1)', [anchorIds])
      : [];
    const anchorById = new Map(anchors.map(l => [l.id, l]));
    const rctx = await readinessBatch(anchors);
    const lightExtras = await lightForJobCards(
      cardRows.map(s => ({ id: s.job_card_id, product_id: s.product_id })), one);
    // The card-level half of the light — the expensive half — still computed
    // once per card, exactly as before.
    const baseByJc = new Map();
    for (const s of cardRows) {
      const line = anchorById.get(s.anchor_line_id);
      if (!line) continue;
      baseByJc.set(s.job_card_id, {
        // Served entirely from rctx — no round trip per card.
        gates: await readiness(line, one, rctx),
        ...lightExtras.get(s.job_card_id),
        machineId: s.card_machine_id,
        finalisedAt: s.finalised_at,
        toolingOk: line.tooling_ok,
        override: {
          on: !!s.ready_override, by: s.ready_override_by,
          at: s.ready_override_at, reason: s.ready_override_reason,
        },
      });
    }

    // The light is now per STAGE ROW, not per card: a station is asked only
    // about what it can act on, plus the one fact only a station has — whether
    // the work has physically reached it. An operator at pasting no longer
    // reads a dot that is really about the press.
    //
    // The route comes from its OWN batched query rather than the rows on the
    // board: the board filters by section and state, so "the stage before this
    // one" is not derivable from what happens to be visible.
    const jcIds = [...baseByJc.keys()];
    const allStages = jcIds.length ? await q(
      `SELECT id, job_card_id, seq, stage, status, qty_in, qty_out
       FROM job_stages WHERE job_card_id = ANY($1) ORDER BY job_card_id, seq`, [jcIds]) : [];
    const routeByJc = new Map();
    for (const st of allStages) {
      if (!routeByJc.has(st.job_card_id)) routeByJc.set(st.job_card_id, []);
      routeByJc.get(st.job_card_id).push(st);
    }

    const lightByStage = new Map();
    for (const [jcId, base] of baseByJc) {
      const route = routeByJc.get(jcId) || [];
      route.forEach((row, i) => {
        // Nearest earlier non-QC stage — QC inspects, it does not hand material
        // on, the same rule previousStage() keeps for the completion gate.
        const prev = route.slice(0, i).reverse().find(x => x.stage !== 'qc') || null;
        lightByStage.set(row.id, readinessLight({
          ...base,
          stage: row.stage,
          prevStatus: prev?.status ?? null,
          prevStage: prev?.stage ?? null,
          // What is actually in front of this station: its own stamped input
          // once started, else what the stage before it has produced so far.
          // (/floor/:section passes receipt.received here — the same quantity,
          // resolved by rowReceipt once the row context exists.)
          qtyReceived: row.qty_in ?? prev?.qty_out ?? 0,
        }));
      });
    }

    const sections = Object.fromEntries(
      SECTIONS.map(s => [s, { section: s, running: [], held: [], queued: [], incoming: [] }]));

    for (const list of Object.values(byJc)) {
      list.sort((a, b) => a.seq - b.seq);
      for (const s of list) {
        if (s.status === 'completed') continue;
        const prev = prevStageOf(list, s);
        const state = frontierState(s, prev);
        const receipt = rowReceipt(s, prev);
        const entry = {
          stage_id: s.id, job_card_id: s.job_card_id, jc_number: s.jc_number, seq: s.seq, stage: s.stage,
          // Board-issue gate on the floor board: cutting + a real order line
          // (NULL for a gang card — see the SELECT comment above).
          order_line_id: s.order_line_id,
          gang_run_id: s.gang_run_id, gang_number: s.gang_number, gang_members: s.gang_members,
          product_name: s.product_name, product_code: s.product_code,
          customer_name: s.customer_name, po_number: s.po_number, delivery_date: s.delivery_date,
          unit: s.unit, qty_in: s.qty_in, qty_planned: s.qty_planned, children_per_parent: s.children_per_parent,
          ...receipt,
          expected_qty: receipt.received || s.qty_planned || s.sheets_issued,
          operator: s.operator, started_at: s.started_at, hold_reason: s.hold_reason,
          machine_name: s.machine_name, machine_id: s.machine_id,
          queue_pos: s.queue_pos, floor_pos: s.floor_pos, delivery_date: s.delivery_date,
          upstream: prev ? { stage: prev.stage, status: prev.status } : null,
          board_pending: s.board_pending, open_xs: s.open_xs,
          light: lightByStage.get(s.id) ?? null,
          startable: s.status === 'pending',
          state,
        };
        // 'partial' is a stage with day-wise counts already recorded — part-run,
        // not still upstream. It used to fall through to `incoming`, where the
        // board read it as "waiting for the previous stage".
        if (state === 'running' || state === 'partial') sections[s.stage].running.push(entry);
        else if (state === 'hold') sections[s.stage].held.push(entry);
        else if (state === 'queued') sections[s.stage].queued.push(entry);
        else sections[s.stage].incoming.push(entry);
      }
    }

    // byJc iterates numeric keys ascending — restore the planned order. Board
    // order is one comparator shared by every floor board (floor-order.js), so
    // the four cannot drift: the floor's own order first, then print-planning's
    // queue_pos, then delivery date.
    for (const sec of Object.values(sections)) {
      // orderBoard, not a bare comparator: each of these lists spans several
      // lanes (every machine of the section, plus its unpinned pool), and a
      // floor_pos from one lane says nothing about a floor_pos from another.
      sec.running = orderBoard(sec.running); sec.held = orderBoard(sec.held);
      sec.queued = orderBoard(sec.queued); sec.incoming = orderBoard(sec.incoming);
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

    // Today's output per machine, for the machine row inside each band.
    const todayRows = await q(`
      SELECT machine_id, COUNT(*)::int AS runs, COALESCE(SUM(qty_out),0)::int AS produced
      FROM job_stages
      WHERE status='completed' AND completed_at::date = current_date AND machine_id IS NOT NULL
      GROUP BY machine_id`);
    const todayBy = Object.fromEntries(todayRows.map(t => [t.machine_id, t]));

    // Station scoping (view filter): a press-scoped operator sees only their
    // press's printing jobs; a station-scoped operator sees only their sections.
    // Applied BEFORE the band is built, so a scoped-out press's work cannot
    // reappear in the section's unpinned lane.
    const { sections: allowSec, machineIds } = await floorScope(req);
    if (machineIds) {
      const keep = new Set(machineIds);
      for (const lane of ['running', 'held', 'queued', 'incoming'])
        sections.printing[lane] = sections.printing[lane]
          .filter(e => e.machine_id != null && keep.has(e.machine_id));
    }

    // One band per section: its machines carrying the work pinned to each, and
    // the section's own unpinned queue listed ONCE below them rather than
    // repeated under every machine of the type.
    let payload = SECTIONS.map(s => {
      const secMachines = (machineIds && s === 'printing')
        ? machines.filter(m => m.type === s && machineIds.includes(m.id))
        : machines.filter(m => m.type === s);
      const live = [...sections[s].running, ...sections[s].held,
                    ...sections[s].queued, ...sections[s].incoming];
      const { pinned, unpinned } = splitByMachine(live, secMachines.map(m => m.id));
      return {
        ...sections[s],
        machines: secMachines.map(m => {
          const jobs = pinned.get(m.id) || [];
          return {
            ...m,
            live: jobs.some(j => j.state === 'running' || j.state === 'partial') ? 'running'
              : m.status === 'maintenance' ? 'maintenance'
              : jobs.some(j => j.state === 'hold') ? 'hold' : 'idle',
            today: todayBy[m.id] || { runs: 0, produced: 0 },
            jobs: jobs.slice(0, 3),
            more: Math.max(0, jobs.length - 3),
          };
        }),
        unpinned: unpinned.slice(0, 3),
        unpinned_more: Math.max(0, unpinned.length - 3),
        today: statsByStage[s] || { completed_today: 0, received_today: 0, produced_today: 0, scrap_today: 0 },
      };
    });
    if (allowSec) payload = payload.filter(s => allowSec.includes(s.section));
    res.json(payload);
  } catch (e) { next(e); }
});

// ── Floor queue order ───────────────────────────────────────────────────────
// Move one job one place along its lane. A lane is the queue as the BOARD draws
// it: the jobs pinned to one machine, or the section's unpinned pool. The move
// never crosses lanes and never touches job_cards.queue_pos, so Print Planning's
// press lanes are unaffected. Registered before /floor/:section so the path wins.
r.post('/floor/queue/move', canRun, async (req, res, next) => {
  try {
    const stageId = +req.body.job_stage_id;
    const dir = req.body.dir;
    if (!stageId) return res.status(400).json({ error: 'job_stage_id is required' });
    if (!['up', 'down'].includes(dir)) return res.status(400).json({ error: "dir must be 'up' or 'down'" });

    const moved = await tx(async (qc, oc) => {
      // Deliberately NOT locked here: locking this one row before the lane
      // scan below is an ABBA waiting to happen — two supervisors pressing ▲
      // on different jobs in the same section would each hold the other's row
      // and Postgres would kill one with a deadlock. The lane scan takes every
      // lock, in a deterministic order.
      const me = await oc(`
        SELECT js.id, js.stage, js.status, js.machine_id, jc.machine_id AS press_machine_id
        FROM job_stages js JOIN job_cards jc ON jc.id = js.job_card_id
        WHERE js.id=$1`, [stageId]);
      if (!me) throw Object.assign(new Error('Stage not found'), { status: 404 });
      if (me.status === 'completed')
        throw Object.assign(new Error('A completed stage has left the queue'), { status: 409 });

      // Same pinning rule the machine board uses: a stage is on the machine it
      // started on, and an unstarted printing stage is on the press Print
      // Planning pinned it to.
      const pinnedTo = row => row.machine_id ?? (row.stage === 'printing' ? row.press_machine_id : null);

      const rows = await qc(`
        SELECT js.id AS stage_id, js.job_card_id, js.stage, js.machine_id, js.floor_pos,
               jc.machine_id AS press_machine_id, jc.queue_pos, o.delivery_date
        FROM job_stages js
        JOIN job_cards jc ON jc.id = js.job_card_id
        LEFT JOIN order_lines ol ON ol.id = jc.order_line_id
        LEFT JOIN LATERAL (
          SELECT ol2.* FROM order_lines ol2
          WHERE ol2.gang_run_id = jc.gang_run_id ORDER BY ol2.id LIMIT 1
        ) gol ON jc.order_line_id IS NULL
        JOIN orders o ON o.id = COALESCE(ol.order_id, gol.order_id)
        WHERE js.stage=$1 AND js.status <> 'completed' AND jc.status IN ('open','in_progress')
        ORDER BY js.id
        FOR UPDATE OF js`, [me.stage]);

      const mine = pinnedTo(me);
      const lane = rows.filter(rw => pinnedTo(rw) === mine);

      const writes = moveWithin(lane, stageId, dir);
      for (const w of writes)
        await qc('UPDATE job_stages SET floor_pos=$1 WHERE id=$2', [w.floor_pos, w.stage_id]);
      if (writes.length)
        await audit('job_stage', stageId, 'floor_reorder',
          `${me.stage}: moved ${dir} on the floor board`, qc, req.user.name);
      return writes.length > 0;
    });

    res.json({ moved });
  } catch (e) { next(e); }
});

// ── Machine control board ───────────────────────────────────────────────────
// Every machine with its live status and top jobs: what's running on it now,
// what's pinned to it (press plan / started runs), and the section queue it
// can pull from next. Registered BEFORE /floor/:section so the path wins.
r.get('/floor/machines', async (req, res, next) => {
  try {
    const stages = await q(`
      SELECT js.id, js.job_card_id, js.seq, js.stage, js.status, js.unit,
             js.qty_in, js.qty_out, js.operator, js.started_at, js.hold_reason, js.floor_pos,
             js.machine_id AS stage_machine_id,
             jc.jc_number, jc.machine_id AS press_machine_id, jc.queue_pos, jc.sheets_issued,
             jc.children_per_parent,
             jc.gang_run_id, gg.gang_number, gg.kind AS run_kind, gm.members AS gang_members,
             p.name AS product_name, p.code AS product_code, p.ups,
             c.name AS customer_name, o.po_number, o.delivery_date,
             COALESCE(xsq.qty, 0) AS extra_issued_parents
      FROM job_stages js
      JOIN job_cards jc ON jc.id = js.job_card_id
      JOIN products p ON p.id = jc.product_id
      LEFT JOIN order_lines ol ON ol.id = jc.order_line_id
      LEFT JOIN LATERAL (
        SELECT ol2.* FROM order_lines ol2
        WHERE ol2.gang_run_id = jc.gang_run_id
        ORDER BY ol2.id LIMIT 1
      ) gol ON jc.order_line_id IS NULL
      JOIN orders o ON o.id = COALESCE(ol.order_id, gol.order_id)
      JOIN customers c ON c.id = o.customer_id
      ${GANG_MEMBERS_LATERAL}
      ${XS_ISSUED_LATERAL}
      WHERE jc.status IN ('open','in_progress')
      ORDER BY jc.id, js.seq`);

    // Same frontier logic as /floor — one live state per open stage.
    const byJc = {};
    for (const s of stages) (byJc[s.job_card_id] ||= []).push(s);
    const entries = [];
    for (const list of Object.values(byJc)) {
      list.sort((a, b) => a.seq - b.seq);
      for (const s of list) {
        if (s.status === 'completed') continue;
        const prev = prevStageOf(list, s);
        const receipt = rowReceipt(s, prev);
        entries.push({
          stage_id: s.id, job_card_id: s.job_card_id, jc_number: s.jc_number,
          stage: s.stage,
          state: frontierState(s, prev),
          startable: s.status === 'pending',
          gang_run_id: s.gang_run_id, gang_number: s.gang_number, gang_members: s.gang_members,
          product_name: s.product_name, customer_name: s.customer_name,
          ...receipt,
          qty: receipt.received || s.sheets_issued, unit: s.unit,
          operator: s.operator, started_at: s.started_at, hold_reason: s.hold_reason,
          queue_pos: s.queue_pos, floor_pos: s.floor_pos, delivery_date: s.delivery_date,
          // A stage is pinned to the machine it started on; a printing stage
          // that hasn't started yet is pinned to the press from Print Planning.
          machine_id: s.stage_machine_id ?? (s.stage === 'printing' ? s.press_machine_id : null),
        });
      }
    }

    // Live work first, then the lane's own order (splitByMachine already
    // applied it) — a machine card is sliced to three rows, and the job
    // actually on the press must never be the one that falls off.
    const jobSort = byState;

    const machines = await q('SELECT * FROM machines WHERE COALESCE(active,1)=1');
    machines.sort((a, b) => machineTypeRank(a.type) - machineTypeRank(b.type)
      || a.name.localeCompare(b.name));

    const todayRows = await q(`
      SELECT machine_id, COUNT(*)::int AS runs, COALESCE(SUM(qty_out),0)::int AS produced
      FROM job_stages
      WHERE status='completed' AND completed_at::date = current_date AND machine_id IS NOT NULL
      GROUP BY machine_id`);
    const todayBy = Object.fromEntries(todayRows.map(t => [t.machine_id, t]));

    // Station scoping (view filter): press-scoped operators see only their
    // press card; station-scoped operators see only their sections' machines.
    const { sections: allowSec, machineIds } = await floorScope(req);
    let board = machines;
    if (machineIds) { const keep = new Set(machineIds); board = machines.filter(m => keep.has(m.id)); }
    else if (allowSec) board = machines.filter(m => allowSec.includes(m.type));

    const machineIdsOnBoard = board.map(m => m.id);
    const byStage = {};
    for (const e of entries) (byStage[e.stage] ||= []).push(e);
    const splitOf = Object.fromEntries(Object.entries(byStage)
      .map(([stage, list]) => [stage, splitByMachine(list, machineIdsOnBoard)]));

    res.json(board.map(m => {
      // Only what is actually pinned to this machine. The section's unpinned
      // queue is a section-level lane now (see /floor): handing it to every
      // machine of the type listed one job N times and, because the top-3 slice
      // ran after the merge, pushed real pinned work off the card.
      const jobs = (splitOf[m.type]?.pinned.get(m.id) || []).sort(jobSort);
      return {
        id: m.id, name: m.name, type: m.type, status: m.status,
        capacity_per_hour: m.capacity_per_hour,
        live: jobs.some(e => e.state === 'running') ? 'running'
          : m.status === 'maintenance' ? 'maintenance'
          : jobs.some(e => e.state === 'hold') ? 'hold' : 'idle',
        today: todayBy[m.id] || { runs: 0, produced: 0 },
        jobs: jobs.slice(0, 3),
        more: Math.max(0, jobs.length - 3),
      };
    }));
  } catch (e) { next(e); }
});

// Machine log — every run that touched this machine plus its audit trail
// (stage start/hold/complete/adjust entries and machine status changes).
r.get('/floor/machines/:id/log', async (req, res, next) => {
  try {
    const machine = await one('SELECT * FROM machines WHERE id=$1', [req.params.id]);
    if (!machine) return res.status(404).json({ error: 'Machine not found' });

    const runs = (await q(`
      SELECT js.id, js.stage, js.status, js.unit, js.qty_in, js.qty_out, js.qty_scrap,
             js.operator, js.started_at, js.completed_at, js.hold_reason,
             jc.jc_number, gg.gang_number, gg.kind AS run_kind, gm.members AS gang_members,
             p.name AS product_name, c.name AS customer_name
      FROM job_stages js
      JOIN job_cards jc ON jc.id = js.job_card_id
      JOIN products p ON p.id = jc.product_id
      LEFT JOIN order_lines ol ON ol.id = jc.order_line_id
      LEFT JOIN LATERAL (
        SELECT ol2.* FROM order_lines ol2
        WHERE ol2.gang_run_id = jc.gang_run_id
        ORDER BY ol2.id LIMIT 1
      ) gol ON jc.order_line_id IS NULL
      JOIN orders o ON o.id = COALESCE(ol.order_id, gol.order_id)
      JOIN customers c ON c.id = o.customer_id
      ${GANG_MEMBERS_LATERAL}
      WHERE js.machine_id = $1
      ORDER BY COALESCE(js.completed_at, js.started_at) DESC NULLS LAST, js.id DESC
      LIMIT 50`, [req.params.id]))
      .map(s => ({
        ...s,
        yield_pct: s.status === 'completed' && s.qty_in > 0 ? +(100 * s.qty_out / s.qty_in).toFixed(1) : null,
        duration_min: s.started_at && s.completed_at
          ? Math.round((new Date(s.completed_at) - new Date(s.started_at)) / 60000) : null,
      }));

    const trail = await q(`
      SELECT al.*, js.stage, jc.jc_number
      FROM audit_log al
      JOIN job_stages js ON al.entity = 'job_stage' AND js.id = al.entity_id
      JOIN job_cards jc ON jc.id = js.job_card_id
      WHERE js.machine_id = $1
      UNION ALL
      SELECT al.*, NULL AS stage, NULL AS jc_number
      FROM audit_log al
      WHERE al.entity = 'machine' AND al.entity_id = $1
      ORDER BY id DESC LIMIT 100`, [req.params.id]);

    res.json({ machine, runs, audit: trail });
  } catch (e) { next(e); }
});

// Machine status control from the board — running / idle / maintenance.
r.put('/floor/machines/:id/status', canRun, async (req, res, next) => {
  try {
    const { status } = req.body;
    if (!['running', 'idle', 'maintenance'].includes(status)) {
      return res.status(400).json({ error: 'status must be running, idle or maintenance' });
    }
    const m = await one('UPDATE machines SET status=$1 WHERE id=$2 RETURNING *', [status, req.params.id]);
    if (!m) return res.status(404).json({ error: 'Machine not found' });
    await audit('machine', m.id, `status:${status}`, m.name, q, req.user.name);
    res.json(m);
  } catch (e) { next(e); }
});

// ── Unified Sort & Paste station ────────────────────────────────────────────
// Sorting and Pasting collapsed into ONE operator workspace. A job enters at
// sorting; the operator sorts (mandatory waste gate), then pastes row-by-row
// (auto / manual / both / split), then packs — all in one completion. Registered
// BEFORE /floor/:section so this literal path wins over the :section param.
r.get('/floor/sort-paste', async (req, res, next) => {
  try {
    // Station scoping: this combined station belongs to sorting + pasting. A
    // user scoped away from both can't open it.
    const { sections: allowSec } = await floorScope(req);
    if (allowSec && !allowSec.includes('sorting') && !allowSec.includes('pasting')) {
      return res.status(403).json({ error: "You don't have access to the Sort & Paste station" });
    }
    // Live queue: every open job whose Pasting hasn't finished. The active phase
    // is Sorting until it completes, then Pasting — the queue state and start
    // button key off whichever stage is live.
    const rows = await q(`${STAGE_VIEW} WHERE jc.status IN ('open','in_progress')
      ORDER BY jc.queue_pos NULLS LAST, o.delivery_date NULLS LAST, jc.id, js.seq`);
    const byJc = {};
    for (const s of rows) (byJc[s.job_card_id] ||= []).push(s);

    let queue = [];
    for (const list of Object.values(byJc)) {
      list.sort((a, b) => a.seq - b.seq);
      const sortSt = list.find(s => s.stage === 'sorting');
      const pasteSt = list.find(s => s.stage === 'pasting');
      if (!sortSt || !pasteSt || pasteSt.status === 'completed') continue;
      const active = sortSt.status !== 'completed' ? sortSt : pasteSt;
      const prev = prevStageOf(list, active);
      // Upstream counted-so-far in the active stage's unit (see /floor/:section).
      const receipt = rowReceipt(active, prev);
      queue.push({
        ...active,
        phase: sortSt.status !== 'completed' ? 'sort' : 'paste',
        sorting_stage_id: sortSt.id, sorting_status: sortSt.status,
        sorting_qty_in: sortSt.qty_in, sorting_qty_out: sortSt.qty_out,
        pasting_stage_id: pasteSt.id, pasting_status: pasteSt.status,
        active_stage_id: active.id, active_stage: active.stage,
        ...receipt,
        expected_qty: receipt.received || active.qty_planned || active.sheets_issued,
        queue_state: frontierState(active, prev),
        startable: active.status === 'pending',
        upstream: prev ? { stage: prev.stage, status: prev.status } : null,
      });
    }
    // This station's list mixes SORTING rows with PASTING rows — two different
    // lanes. orderBoard keeps the plant's delivery order across them and only
    // applies a lane's manual order inside its own slots, so reordering the
    // sorting lane can never float unsorted jobs above work shipping today.
    queue = orderBoard(queue);

    // Completed runs — one row per finished Pasting stage, carrying the sorted
    // waste from its Sorting sibling and its per-row auto/manual breakdown.
    const completed = (await q(`
      SELECT ps.id, ps.job_card_id, ps.qty_in, ps.qty_out, ps.qty_scrap, ps.scrap_reason,
             ps.operator, ps.started_at, ps.completed_at, ps.unit, ps.pack_boxes,
             ss.qty_in AS sorted_in, ss.qty_out AS sorted_good, ss.qty_scrap AS sorted_waste,
             ss.scrap_reason AS sorted_waste_reason,
             jc.jc_number, p.name AS product_name, p.code AS product_code, c.name AS customer_name,
             COALESCE(pr.auto,0) AS auto_qty, COALESCE(pr.manual,0) AS manual_qty
      FROM job_stages ps
      JOIN job_stages ss ON ss.job_card_id = ps.job_card_id AND ss.stage='sorting'
      JOIN job_cards jc ON jc.id = ps.job_card_id
      JOIN products p ON p.id = jc.product_id
      -- LEFT + anchor fallback: a COMBINED RUN's card completes pasting with
      -- order_line_id NULL — an INNER join here silently dropped the finished
      -- run from the station's own Completed tab. (A gang parent never reaches
      -- pasting, so only merges ever take the gol arm.)
      LEFT JOIN order_lines ol ON ol.id = jc.order_line_id
      LEFT JOIN LATERAL (
        SELECT ol2.* FROM order_lines ol2
        WHERE ol2.gang_run_id = jc.gang_run_id
        ORDER BY ol2.id LIMIT 1
      ) gol ON jc.order_line_id IS NULL
      LEFT JOIN orders o ON o.id = COALESCE(ol.order_id, gol.order_id)
      LEFT JOIN customers c ON c.id = o.customer_id
      LEFT JOIN LATERAL (
        SELECT SUM(auto_qty) AS auto, SUM(manual_qty) AS manual
        FROM pasting_rows WHERE job_stage_id = ps.id) pr ON true
      WHERE ps.stage='pasting' AND ps.status='completed'
      ORDER BY ps.completed_at DESC LIMIT 200`))
      .map(s => ({
        ...s,
        yield_pct: s.sorted_in > 0 ? +(100 * s.qty_out / s.sorted_in).toFixed(1) : null,
        duration_min: s.started_at && s.completed_at
          ? Math.round((new Date(s.completed_at) - new Date(s.started_at)) / 60000) : null,
      }));

    // KPIs across both stages, today.
    const today = await one(`
      SELECT
        COUNT(*) FILTER (WHERE stage='pasting')::int AS completed_today,
        COALESCE(SUM(qty_scrap) FILTER (WHERE stage='sorting'),0)::int AS sorted_waste_today,
        COALESCE(SUM(qty_out) FILTER (WHERE stage='pasting'),0)::int AS pasted_today,
        COALESCE(SUM(qty_scrap) FILTER (WHERE stage='pasting'),0)::int AS paste_waste_today,
        COALESCE(SUM(qty_in) FILTER (WHERE stage='sorting'),0)::int AS received_today
      FROM job_stages
      WHERE status='completed' AND completed_at::date = current_date AND stage IN ('sorting','pasting')`);
    const kpis = {
      pending: queue.filter(s => s.queue_state === 'queued').length,
      incoming: queue.filter(s => s.queue_state === 'incoming').length,
      running: queue.filter(s => ['running', 'partial'].includes(s.queue_state)).length,
      on_hold: queue.filter(s => s.queue_state === 'hold').length,
      completed_today: today.completed_today,
      received_today: today.received_today,
      produced_today: today.pasted_today,
      sorted_waste_today: today.sorted_waste_today,
      paste_waste_today: today.paste_waste_today,
      scrap_today: today.sorted_waste_today + today.paste_waste_today,
      yield_today: today.received_today > 0
        ? +(100 * today.pasted_today / today.received_today).toFixed(1) : null,
    };

    // Merged audit trail for both stages.
    const audit = await q(`
      SELECT al.*, js.stage, jc.jc_number
      FROM audit_log al
      JOIN job_stages js ON js.id = al.entity_id
      JOIN job_cards jc ON jc.id = js.job_card_id
      WHERE al.entity='job_stage' AND js.stage IN ('sorting','pasting')
      ORDER BY al.id DESC LIMIT 100`);

    // Pasting workstations for the grid — the two folder-gluers plus Manual
    // Pasting — each with its assigned crew for the operator picker.
    const machines = await q(`
      SELECT m.*, COALESCE(ops.operators, '[]'::json) AS operators
      FROM machines m
      LEFT JOIN LATERAL (
        SELECT json_agg(json_build_object('id', e.id, 'name', e.name, 'role', e.role) ORDER BY e.name) AS operators
        FROM machine_operators mo JOIN employees e ON e.id=mo.employee_id
        WHERE mo.machine_id=m.id AND e.active=1) ops ON true
      WHERE m.type='pasting' AND COALESCE(m.active,1)=1 ORDER BY m.is_manual, m.name`);

    res.json({ section: 'sort_paste', kpis, queue, completed, audit, machines });
  } catch (e) { next(e); }
});

// One section's full workspace: KPIs, live queue, completed runs, audit trail.
r.get('/floor/:section', async (req, res, next) => {
  try {
    const section = req.params.section;
    if (!SECTIONS.includes(section)) return res.status(404).json({ error: 'Unknown section' });

    // Station scoping (view filter). A station-scoped operator can't open a
    // section outside their set; a press-scoped operator only sees their press.
    const { sections: allowSec, machineIds } = await floorScope(req);
    if (allowSec && !allowSec.includes(section)) {
      return res.status(403).json({ error: "You don't have access to this station" });
    }
    const pressKeep = (machineIds && section === 'printing') ? new Set(machineIds) : null;

    // Live queue for this section, with the same frontier logic as /floor.
    const open = await q(`${STAGE_VIEW} WHERE jc.status IN ('open','in_progress')
      ORDER BY jc.queue_pos NULLS LAST, o.delivery_date NULLS LAST, jc.id, js.seq`);
    const byJc = {};
    for (const s of open) (byJc[s.job_card_id] ||= []).push(s);

    // The station's own traffic light. /floor (the board) computes this too —
    // this endpoint is what the single-section workspace reads, and it carried
    // no light at all, so Section.jsx had nothing to render. Same inputs and
    // the same helper, so a job cannot show one colour on the Live Floor and a
    // different one on its own station page.
    const secCardRows = Object.values(byJc).map(list => list[0]);
    const secAnchorIds = [...new Set(secCardRows.map(s => s.anchor_line_id).filter(x => x != null))];
    const secAnchors = secAnchorIds.length
      ? await q('SELECT * FROM order_lines WHERE id = ANY($1)', [secAnchorIds])
      : [];
    const secAnchorById = new Map(secAnchors.map(l => [l.id, l]));
    const secRctx = await readinessBatch(secAnchors);
    const secExtras = await lightForJobCards(
      secCardRows.map(s => ({ id: s.job_card_id, product_id: s.product_id })), one);
    const secBase = new Map();
    for (const s of secCardRows) {
      const line = secAnchorById.get(s.anchor_line_id);
      if (!line) continue;
      secBase.set(s.job_card_id, {
        gates: await readiness(line, one, secRctx),
        ...secExtras.get(s.job_card_id),
        machineId: s.card_machine_id,
        finalisedAt: s.finalised_at,
        toolingOk: line.tooling_ok,
        override: {
          on: !!s.ready_override, by: s.ready_override_by,
          at: s.ready_override_at, reason: s.ready_override_reason,
        },
      });
    }

    let queue = [];
    for (const list of Object.values(byJc)) {
      list.sort((a, b) => a.seq - b.seq);
      for (const s of list) {
        if (s.stage !== section || s.status === 'completed') continue;
        const prev = prevStageOf(list, s);
        // What upstream has counted SO FAR, in this stage's unit — partial or
        // final — plus the extra sheets issued straight here. This is the
        // received quantity the station is shown, and the basis the
        // partial-entry UI measures against.
        const receipt = rowReceipt(s, prev);
        queue.push({
          ...s,
          ...receipt,
          expected_qty: receipt.received || s.qty_planned || s.sheets_issued,
          queue_state: frontierState(s, prev),
          startable: s.status === 'pending',
          upstream: prev ? { stage: prev.stage, status: prev.status } : null,
          // qtyReceived is receipt.received — the very figure this station is
          // SHOWN and is allowed to record against, so the dot and the number
          // beside it can never disagree.
          light: secBase.has(s.job_card_id) ? readinessLight({
            ...secBase.get(s.job_card_id),
            stage: s.stage,
            prevStatus: prev?.status ?? null,
            prevStage: prev?.stage ?? null,
            qtyReceived: +receipt.received || 0,
          }) : null,
        });
      }
    }
    // The section page flattens every machine lane and the unpinned pool into
    // one list, so floor_pos is compared only within each lane (orderBoard) —
    // machine A's #1 and the pool's #1 are not the same claim on the top slot.
    queue = orderBoard(queue);
    // Press scope: keep only jobs on this operator's press.
    if (pressKeep) {
      for (let i = queue.length - 1; i >= 0; i--)
        if (!pressKeep.has(effectiveMachineId(queue[i]))) queue.splice(i, 1);
    }

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
      }))
      .filter(s => !pressKeep || pressKeep.has(effectiveMachineId(s)));

    // Section KPIs
    const today = completed.filter(s => new Date(s.completed_at).toDateString() === new Date().toDateString());
    const sum = (rows, k) => rows.reduce((a, r) => a + (r[k] || 0), 0);
    const kpis = {
      pending: queue.filter(s => s.queue_state === 'queued').length,
      incoming: queue.filter(s => s.queue_state === 'incoming').length,
      running: queue.filter(s => ['running', 'partial'].includes(s.queue_state)).length,
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

    // Section machines with their assigned operators — the start-run modal
    // filters its operator picker to the selected machine's crew.
    const machines = await q(`
      SELECT m.*, COALESCE(ops.operators, '[]'::json) AS operators
      FROM machines m
      LEFT JOIN LATERAL (
        SELECT json_agg(json_build_object('id', e.id, 'name', e.name, 'role', e.role) ORDER BY e.name) AS operators
        FROM machine_operators mo JOIN employees e ON e.id=mo.employee_id
        WHERE mo.machine_id=m.id AND e.active=1) ops ON true
      WHERE m.type=$1 AND COALESCE(m.active,1)=1 ORDER BY m.name`, [section]);

    res.json({
      section, kpis, queue, completed, audit,
      machines: pressKeep ? machines.filter(m => pressKeep.has(m.id)) : machines,
    });
  } catch (e) { next(e); }
});

// ── Track ───────────────────────────────────────────────────────────────────
r.get('/track', async (_req, res, next) => {
  try {
    res.json(await q(`
      SELECT ol.id, ol.qty, ol.dispatched_qty, ol.status, ol.planned_date,
             o.po_number, o.delivery_date, c.name AS customer_name,
             p.name AS product_name, p.code AS product_code,
             jc.jc_number, ol.gang_run_id, gg.gang_number, gg.kind AS run_kind,
             (jc.id IS NOT NULL AND jc.order_line_id IS NULL) AS gang_parent_job,
             (SELECT stage FROM job_stages WHERE job_card_id=jc.id AND status IN ('in_progress','partially_completed') ORDER BY seq LIMIT 1) AS current_stage,
             (SELECT stage FROM job_stages WHERE job_card_id=jc.id AND status='pending' ORDER BY seq LIMIT 1) AS next_stage,
             (SELECT COUNT(*)::int FROM job_stages WHERE job_card_id=jc.id AND status='completed') AS done_stages,
             (SELECT COUNT(*)::int FROM job_stages WHERE job_card_id=jc.id) AS total_stages
      FROM order_lines ol
      JOIN orders o ON o.id = ol.order_id
      JOIN customers c ON c.id = o.customer_id
      JOIN products p ON p.id = ol.product_id
      LEFT JOIN gang_runs gg ON gg.id = ol.gang_run_id
      LEFT JOIN LATERAL (
        -- Own card first (solo, or the split child); before the split the
        -- gang PARENT card carries this line's production position.
        SELECT jc2.* FROM job_cards jc2
        WHERE jc2.order_line_id = ol.id
           OR (ol.gang_run_id IS NOT NULL AND jc2.gang_run_id = ol.gang_run_id
               AND jc2.order_line_id IS NULL AND jc2.status IN ('open','in_progress'))
        ORDER BY CASE WHEN jc2.order_line_id = ol.id THEN 0 ELSE 1 END, jc2.id DESC
        LIMIT 1
      ) jc ON true
      WHERE ol.status != 'cancelled'
      ORDER BY (ol.status='dispatched'), o.delivery_date NULLS LAST, ol.id DESC`));
  } catch (e) { next(e); }
});

r.get('/track/:id', async (req, res, next) => {
  try {
    const line = await one(`
      SELECT ol.*, o.po_number, o.po_date, o.delivery_date, o.created_at AS order_created_at,
             o.status AS order_status, c.name AS customer_name, c.city,
             p.name AS product_name, p.code AS product_code, p.size, p.colors, p.coating, p.special, p.ups, p.tool_id,
             bm.name AS board_name, m.name AS machine_name, gg.gang_number, gg.kind AS run_kind
      FROM order_lines ol
      JOIN orders o ON o.id = ol.order_id
      JOIN customers c ON c.id = o.customer_id
      JOIN products p ON p.id = ol.product_id
      JOIN materials bm ON bm.id = p.board_material_id
      LEFT JOIN machines m ON m.id = ol.machine_id
      LEFT JOIN gang_runs gg ON gg.id = ol.gang_run_id
      WHERE ol.id = $1`, [req.params.id]);
    if (!line) return res.status(404).json({ error: 'Order line not found' });

    // A ganged line rides the gang PARENT card (one shared physical run) until
    // die cutting, then continues on its own split child card. The journey
    // shows both halves as one timeline.
    const ownJc = await one('SELECT * FROM job_cards WHERE order_line_id=$1', [line.id]);
    let gangJc = null;
    let gangMates = [];
    if (line.gang_run_id) {
      gangJc = await one(
        `SELECT * FROM job_cards WHERE gang_run_id=$1 AND order_line_id IS NULL`,
        [line.gang_run_id]);
      gangMates = await q(`
        SELECT p2.name AS product_name, ol2.qty
        FROM order_lines ol2 JOIN products p2 ON p2.id = ol2.product_id
        WHERE ol2.gang_run_id=$1 AND ol2.id != $2 ORDER BY ol2.id`, [line.gang_run_id, line.id]);
    }
    const jc = ownJc || gangJc;
    const gangStages = gangJc
      ? await q('SELECT * FROM job_stages WHERE job_card_id=$1 ORDER BY seq', [gangJc.id])
      : [];
    const ownStages = ownJc
      ? await q('SELECT * FROM job_stages WHERE job_card_id=$1 ORDER BY seq', [ownJc.id])
      : [];
    const stages = [...gangStages.map(s => ({ ...s, gang_shared: true })), ...ownStages];
    const issues = jc
      ? await q(`SELECT sm.*, b.batch_no FROM stock_movements sm
                 LEFT JOIN stock_batches b ON b.id = sm.batch_id
                 WHERE sm.ref_type='job_card' AND sm.ref_id=$1 AND sm.type='consumption'
                 ORDER BY sm.id`, [(gangJc || jc).id])
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
      detail: line.sheets_required
        ? `${(line.sheets_required ?? 0).toLocaleString('en-IN')} sheets (${line.board_name})`
          + `${line.machine_name ? ` · ${line.machine_name}` : ''}${line.planned_date ? ` · ${line.planned_date}` : ''}`
        : 'Waiting for plan lock',
      at: plannedAudit?.created_at ?? null, by: plannedAudit?.user_name,
      state: line.sheets_required ? 'done' : 'todo',
    });

    const artAudit = trail.filter(t => t.action === 'artwork_locked').pop();
    events.push({
      key: 'artwork', title: 'Artwork approved & locked',
      detail: line.artwork_locked ? 'Customer ✓ and QA ✓ — locked for print'
        : `${line.artwork_customer_ok ? 'Customer ✓' : 'Customer pending'} · ${line.artwork_qa_ok ? 'QA ✓' : 'QA pending'}`,
      at: artAudit?.created_at ?? null, by: artAudit?.user_name,
      state: line.artwork_locked ? 'done' : 'todo',
    });

    // Tooling — Artwork's sibling gate: physical tools from maker to rack.
    const lineTools = await q(
      'SELECT * FROM tools WHERE product_id=$1 OR id=$2',
      [line.product_id, line.tool_id ?? -1]);
    const tDetail = toolingDetail({ id: line.product_id, special: line.special, tool_id: line.tool_id }, lineTools);
    const tReady = toolingGateOk(tDetail, line.tooling_ok);
    const toolMove = await one(`
      SELECT te.at, te.user_name FROM tool_events te JOIN tools t ON t.id = te.tool_id
      WHERE (t.product_id=$1 OR t.id=$2) AND te.action='moved' AND te.to_zone='in_rack'
      ORDER BY te.id DESC LIMIT 1`, [line.product_id, line.tool_id ?? -1]);
    events.push({
      key: 'tooling', title: 'Tooling ready',
      detail: tReady
        ? (tDetail.filter(d => d.status === 'ready').map(d => `${d.label} ✓`).join(' · ') || 'Manual override ✓')
        : tDetail.filter(d => d.status !== 'ready')
            .map(d => `${d.label} ${d.status === 'missing' ? 'missing' : 'not ready'}`).join(' · '),
      at: tReady ? toolMove?.at ?? null : null, by: toolMove?.user_name,
      state: tReady ? 'done' : 'todo',
    });

    if (jc) {
      const releaseJc = gangJc || jc;
      events.push({
        key: 'jobcard',
        title: gangJc
          ? `Gang job card ${releaseJc.jc_number} released`
          : `Job card ${releaseJc.jc_number} released`,
        detail: `${releaseJc.sheets_issued.toLocaleString('en-IN')} sheets issued${issues.length ? ` — batch ${issues.map(i => i.batch_no).filter(Boolean).join(', ')}` : ''}`
          + (gangJc ? ` · ${line.gang_number} — one shared run with ${gangMates.map(m => m.product_name).join(' + ') || 'the gang'} until die cutting` : ''),
        at: releaseJc.created_at, state: 'done',
      });
      for (const st of stages) {
        events.push({
          key: `stage-${st.id}`, title: (st.stage === 'qc' ? 'QC' : st.stage.replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase()))
            + (st.gang_shared ? ` — gang run` : ''),
          stage: st.stage, gang_shared: !!st.gang_shared,
          detail: (st.status === 'completed'
            ? `${(st.qty_in ?? 0).toLocaleString('en-IN')} in → ${(st.qty_out ?? 0).toLocaleString('en-IN')} out · ${st.qty_scrap.toLocaleString('en-IN')} scrap ${st.unit}${st.operator ? ` · ${st.operator}` : ''}`
            : st.status === 'partially_completed'
              ? `Partially done — ${(st.qty_out ?? 0).toLocaleString('en-IN')} of ${(st.qty_in ?? 0).toLocaleString('en-IN')} ${st.unit} so far${st.operator ? ` · ${st.operator}` : ''}`
            : st.status === 'in_progress'
              ? `Running now — ${(st.qty_in ?? 0).toLocaleString('en-IN')} ${st.unit} in${st.operator ? ` · ${st.operator}` : ''}`
              : 'Waiting in queue')
            + (st.gang_shared ? ` · combined ${line.gang_number} sheets` : ''),
          at: st.completed_at ?? st.started_at ?? null,
          state: st.status === 'completed' ? 'done' : ['in_progress', 'partially_completed'].includes(st.status) ? 'active' : 'todo',
        });
      }
      if (gangJc && !ownJc) {
        events.push({
          key: 'split', title: 'Splits into its own job card',
          detail: 'After die cutting the gang separates — this product continues alone through sorting → pasting → QC',
          at: null, state: 'todo',
        });
      }
      if (gangJc && ownJc) {
        const splitIdx = events.findIndex(e => e.key === `stage-${ownStages[0]?.id}`);
        events.splice(splitIdx === -1 ? events.length : splitIdx, 0, {
          key: 'split', title: `Split from ${gangJc.jc_number} — own job card ${ownJc.jc_number}`,
          detail: 'Die cutting done — the gang separated into individual cartons',
          at: ownJc.created_at, state: 'done',
        });
      }
      const fgJc = ownJc || jc;
      events.push({
        key: 'fg', title: 'Finished goods to warehouse',
        detail: fgJc.status === 'closed' ? `${fgJc.qty_produced.toLocaleString('en-IN')} cartons in · ${fgJc.qty_scrap.toLocaleString('en-IN')} total scrap` : 'After final QC',
        at: fgJc.closed_at, state: fgJc.status === 'closed' ? 'done' : 'todo',
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
