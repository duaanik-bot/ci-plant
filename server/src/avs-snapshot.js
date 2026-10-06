// Everything the AVS check reads about a photo set's job, in ONE answer
// (owner's request "reduce the time", 6 Oct 2026; runbook 2.5b, 2.5c, 2C.3a).
//
// Before this the check ran 6 to 10 separate SELECTs through the Supabase
// connector (each a turn of the session, 1 to 3 minutes in all). The robot
// route GET /api/avs/robot/job-snapshot/:setId (routes/avs-robot.js) runs the
// same reads here, read only, and the check's prefetch script saves the answer
// as snapshot.json while Claude reads the photos.
//
// SELECT only. Every list is capped, so one odd product can never make the
// answer huge; the caps are in the answer (`limits`) so the check knows when a
// list may be cut.
export const SNAPSHOT_LIMITS = { order_lines: 200, job_cards: 60, runs: 400, dispatches: 60, lots: 40, reports: 30 };

const ids = rows => [...new Set(rows.map(r => r.id).filter(Boolean).map(Number))];

// run(text, params) -> rows. `set` is the avs.check_requests row.
export async function jobSnapshot(run, set) {
  const L = SNAPSHOT_LIMITS;
  const cardIds = [...new Set([
    ...(Array.isArray(set.job_cards) ? set.job_cards.map(c => Number(c.id)) : []),
    Number(set.job_card_id) || null,
  ].filter(Boolean))];

  const setCards = cardIds.length ? await run(`SELECT jc.id, jc.jc_number, jc.order_line_id, jc.product_id, jc.gang_run_id,
      jc.qty_planned, jc.sheets_issued, jc.qty_produced, jc.qty_scrap, jc.status, jc.created_at, jc.closed_at, m.name AS machine
    FROM job_cards jc LEFT JOIN machines m ON m.id = jc.machine_id WHERE jc.id = ANY($1::int[])`, [cardIds]) : [];
  const setProductIds = [...new Set(setCards.map(c => c.product_id).filter(Boolean).map(Number))];

  // The item, and other items of the same customer item code or artwork code (old revisions still active).
  const products = setProductIds.length ? await run(`SELECT p.id, p.customer_id, c.name AS customer, p.name, p.code, p.party_item_code,
      p.party_artwork_code, p.internal_carton_code, p.size, p.gsm, p.board_name, p.rate, p.mrp, p.active, p.ups, p.die_number,
      p.shade_card_number, p.output_number, p.coating, p.emboss, p.pasting_type, p.print_instructions,
      (p.id = ANY($1::int[])) AS on_this_set
    FROM products p LEFT JOIN customers c ON c.id = p.customer_id
    WHERE p.id = ANY($1::int[])
       OR (p.party_item_code IS NOT NULL AND p.party_item_code <> '' AND upper(p.party_item_code) IN
            (SELECT upper(x.party_item_code) FROM products x WHERE x.id = ANY($1::int[]) AND COALESCE(x.party_item_code, '') <> ''))
       OR (p.party_artwork_code IS NOT NULL AND p.party_artwork_code <> '' AND upper(p.party_artwork_code) IN
            (SELECT upper(x.party_artwork_code) FROM products x WHERE x.id = ANY($1::int[]) AND COALESCE(x.party_artwork_code, '') <> ''))
    ORDER BY (p.id = ANY($1::int[])) DESC, p.id DESC LIMIT 20`, [setProductIds]) : [];
  const productIds = ids(products);

  const orderLines = productIds.length ? await run(`SELECT ol.id, ol.order_id, ol.product_id, ol.qty, ol.rate, ol.status, ol.dispatched_qty,
      ol.artwork_customer_ok, ol.artwork_qa_ok, ol.artwork_locked, ol.hold_reason, ol.line_remark, ol.remarks, ol.machine_id,
      ol.planned_date, ol.delivery_date, ol.gang_run_id, ol.short_close_reason, ol.avs_mandatory,
      o.po_number, o.po_date, o.created_at AS entered_at, o.status AS order_status, o.customer_id
    FROM order_lines ol JOIN orders o ON o.id = ol.order_id
    WHERE ol.product_id = ANY($1::int[]) ORDER BY ol.id DESC LIMIT ${L.order_lines}`, [productIds]) : [];
  const lineIds = ids(orderLines);

  const cards = productIds.length ? await run(`SELECT jc.id, jc.jc_number, jc.order_line_id, jc.product_id, jc.gang_run_id, jc.qty_planned,
      jc.sheets_issued, jc.qty_produced, jc.qty_scrap, jc.status, jc.created_at, jc.closed_at, m.name AS machine,
      (jc.id = ANY($2::int[])) AS on_this_set
    FROM job_cards jc LEFT JOIN machines m ON m.id = jc.machine_id
    WHERE jc.product_id = ANY($1::int[]) OR jc.id = ANY($2::int[])
    ORDER BY (jc.id = ANY($2::int[])) DESC, jc.id DESC LIMIT ${L.job_cards}`, [productIds, cardIds])
    : setCards.map(c => ({ ...c, on_this_set: true }));
  const cardIdsAll = ids(cards);

  const stages = cardIdsAll.length ? await run(`SELECT s.id, s.job_card_id, s.seq, s.stage, s.status, s.qty_in, s.qty_out, s.qty_scrap,
      s.hold_reason, s.operator, s.started_at, s.completed_at, s.remarks, m.name AS machine
    FROM job_stages s LEFT JOIN machines m ON m.id = s.machine_id
    WHERE s.job_card_id = ANY($1::int[]) ORDER BY s.job_card_id DESC, s.seq`, [cardIdsAll]) : [];
  const runs = stages.length ? await run(`SELECT r.job_stage_id, r.seq, r.run_date, r.shift, r.qty_good, r.qty_scrap, r.scrap_reason,
      r.operator, r.note, r.created_at, m.name AS machine
    FROM stage_runs r LEFT JOIN machines m ON m.id = r.machine_id
    WHERE r.job_stage_id = ANY($1::int[]) ORDER BY r.job_stage_id, r.seq LIMIT ${L.runs}`, [ids(stages)]) : [];

  const gangIds = [...new Set([...cards, ...orderLines].map(x => x.gang_run_id).filter(Boolean).map(Number))];
  const gangs = gangIds.length ? await run(`SELECT g.id, g.gang_number, g.kind, g.output_number, g.die_number, g.notes, g.avs_mandatory,
      (SELECT json_agg(json_build_object('order_line_id', ol.id, 'product_id', ol.product_id, 'product', p.name, 'qty', ol.qty,
               'po_number', o.po_number, 'line_remark', ol.line_remark) ORDER BY ol.id)
         FROM order_lines ol JOIN orders o ON o.id = ol.order_id LEFT JOIN products p ON p.id = ol.product_id
        WHERE ol.gang_run_id = g.id) AS lines
    FROM gang_runs g WHERE g.id = ANY($1::int[])`, [gangIds]) : [];

  const board = lineIds.length ? await run(`SELECT b.id, b.order_line_id, b.qty, b.status, b.source, b.reason, b.created_at, b.released_at,
      mt.name AS material, mt.gsm, mt.grade, mt.code
    FROM board_allocations b LEFT JOIN materials mt ON mt.id = b.material_id
    WHERE b.order_line_id = ANY($1::int[]) ORDER BY b.order_line_id DESC, b.id`, [lineIds]) : [];

  const dispatches = lineIds.length ? await run(`SELECT dl.order_line_id, dl.qty, d.challan_number, d.dispatched_at
    FROM dispatch_lines dl JOIN dispatches d ON d.id = dl.dispatch_id
    WHERE dl.order_line_id = ANY($1::int[]) ORDER BY d.dispatched_at DESC NULLS LAST LIMIT ${L.dispatches}`, [lineIds]) : [];
  const fgStock = productIds.length ? await run(`SELECT product_id, qty FROM fg_stock WHERE product_id = ANY($1::int[])`, [productIds]) : [];
  const fgLots = productIds.length ? await run(`SELECT id, lot_number, product_id, job_card_id, order_line_id, qty, status, kind,
      dispatch_id, created_at FROM fg_lots WHERE product_id = ANY($1::int[]) AND COALESCE(retired, 0) = 0
    ORDER BY id DESC LIMIT ${L.lots}`, [productIds]) : [];

  const customerIds = [...new Set(products.map(p => p.customer_id).filter(Boolean).map(Number))];
  const customerOpen = customerIds.length ? await run(`SELECT o.customer_id, ol.status, count(*)::int AS lines,
      count(DISTINCT o.id)::int AS pos, COALESCE(sum(ol.qty - COALESCE(ol.dispatched_qty, 0)), 0)::numeric AS qty_pending
    FROM order_lines ol JOIN orders o ON o.id = ol.order_id
    WHERE o.customer_id = ANY($1::int[]) AND ol.status IN ('pending', 'planned', 'in_production', 'produced')
    GROUP BY o.customer_id, ol.status ORDER BY o.customer_id, ol.status`, [customerIds]) : [];

  // AVS: stored links, intake rows and flags, earlier reports, and the set's own documents.
  const soft = async (text, params) => { try { return await run(text, params); } catch (e) { if (['42P01', '3F000', '42703'].includes(e?.code)) return []; throw e; } };
  const artwork = productIds.length ? await soft(`SELECT a.*, m.name AS master_name, m.view_url AS master_url,
      ap.name AS approved_name, ap.view_url AS approved_url
    FROM avs.artwork_codes a
    LEFT JOIN avs.drive_files m ON m.drive_id = a.master_pdf_id
    LEFT JOIN avs.drive_files ap ON ap.drive_id = a.approved_file_id
    WHERE a.product_id = ANY($1::int[])`, [productIds]) : [];
  const intake = productIds.length ? await soft(`SELECT * FROM avs.order_line_intake WHERE product_id = ANY($1::int[])
    ORDER BY po_date DESC NULLS LAST LIMIT 50`, [productIds]) : [];
  const orderIds = [...new Set(orderLines.map(l => l.order_id).filter(Boolean).map(Number))];
  const orderDocs = orderIds.length ? await soft(`SELECT d.*, f.name AS file_name, f.view_url, f.mime
    FROM avs.order_docs d LEFT JOIN avs.drive_files f ON f.drive_id = d.drive_id
    WHERE d.order_id = ANY($1::int[]) ORDER BY d.order_id DESC, d.doc_type`, [orderIds]) : [];
  const flags = orderIds.length ? await soft(`SELECT * FROM avs.order_flags WHERE order_id = ANY($1::int[]) AND cleared_at IS NULL
    ORDER BY raised_at DESC`, [orderIds]) : [];
  const codes = [...new Set(products.flatMap(p => [p.party_item_code, p.party_artwork_code, p.code]).filter(Boolean).map(s => String(s).toUpperCase()))];
  const jcs = [...new Set(cards.map(c => String(c.jc_number || '').toUpperCase()).filter(Boolean))];
  const reports = (codes.length || jcs.length) ? await soft(`SELECT report_no, report_rev, check_no, status, checked_on, product_name,
      artwork_code, revision, item_code, job_card, po_no, key_finding, drive_url
    FROM avs.latest_reports
    WHERE upper(COALESCE(item_code, '')) = ANY($1::text[]) OR upper(COALESCE(artwork_code, '')) = ANY($1::text[])
       OR EXISTS (SELECT 1 FROM unnest($2::text[]) j WHERE upper(COALESCE(job_card, '')) LIKE '%' || j || '%')
    ORDER BY report_no DESC LIMIT ${L.reports}`, [codes, jcs]) : [];
  const setIds = [set.id, set.photos_from_set_id, set.redo_of_set_id].filter(Boolean).map(Number);
  const docs = await soft(`SELECT id, request_id, kind, title, url, file_name, mime, size_bytes, sha256, drive_file_id, drive_url, stored,
      note, added_by, added_at, added_after_report, used_in_report FROM avs.check_docs WHERE request_id = ANY($1::bigint[]) ORDER BY id`, [setIds]);

  return {
    generated_at: new Date().toISOString(),
    limits: L,
    set: {
      id: set.id, status: set.status, jc_number: set.jc_number, job_cards: set.job_cards, product_hint: set.product_hint,
      note: set.note, created_by: set.created_by, created_at: set.created_at, redo_report_no: set.redo_report_no,
      redo_of_set_id: set.redo_of_set_id, photos_from_set_id: set.photos_from_set_id, drive_folder_path: set.drive_folder_path,
    },
    products, order_lines: orderLines, job_cards: cards, job_stages: stages, stage_runs: runs, gangs, board,
    dispatches, fg_stock: fgStock, fg_lots: fgLots, customer_open: customerOpen,
    avs: { artwork_codes: artwork, order_line_intake: intake, order_docs: orderDocs, open_flags: flags, earlier_reports: reports, docs },
  };
}
